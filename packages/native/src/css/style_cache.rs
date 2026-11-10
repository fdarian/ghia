//! What `renderer::apply_styles` makes of a declared style, kept for the next element built from it.
//!
//! The step reads three things: the style, the colours the element has and its lengths. An interned
//! style is one `Arc` however many elements carry it (`StyleTable::intern`) and is not changed once
//! it is shared, so the address of the `Arc` names its content, and a build of the rows of a list
//! applies a handful of distinct styles over and over. The step is the largest part of what
//! building a plain element costs after its text: it parses the border shorthands three times,
//! resolves the fill, the shadows, the radii and the sizes, and writes ~100 fields of a gpui
//! `StyleRefinement`.
//!
//! Only a style that resolution kept as the element's own `Arc` is cached. One that a container
//! query, a state, a transition, a motion, an animation, an overlay or the inherited text
//! decoration made is a fresh value, and has no identity to be found by.
//!
//! The step also reads the colour the element inherits (`currentColor`), which a retained
//! element reports to the subtree around it (`color::reads`). A replay says the read again.

use std::cell::RefCell;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, LazyLock, Weak};

use gpui::{Refineable as _, StyleRefinement, Styled};
use rustc_hash::FxHashMap;

use super::length::LengthContext;
use crate::color::{ColorContext, ColorReads};
use crate::style::StyleDesc;

/// The most styles kept. A cache that reaches it drops the entries of styles nothing holds any more,
/// and then all of them.
const LIMIT: usize = 512;
/// The most contexts kept for one style: the same style under another inherited colour or font size.
const CONTEXTS: usize = 8;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Mode {
    /// Every step is run.
    Off,
    On,
    /// A step that is found kept is run as well, and the two are asserted equal.
    Verify,
}

static MODE: LazyLock<AtomicU8> = LazyLock::new(|| {
    let mode = if std::env::var_os("GPUIX_STYLE_CACHE_OFF").is_some() {
        Mode::Off
    } else if std::env::var_os("GPUIX_RETAIN_VERIFY").is_some() || std::env::var_os("GPUIX_STYLE_CACHE_VERIFY").is_some() {
        Mode::Verify
    } else {
        Mode::On
    };
    AtomicU8::new(mode as u8)
});

/// Off with `GPUIX_STYLE_CACHE_OFF`, verifying with `GPUIX_RETAIN_VERIFY` or `GPUIX_STYLE_CACHE_VERIFY`.
/// Read at every build, so a switch takes the next build.
pub(crate) fn mode() -> Mode {
    match MODE.load(Ordering::Relaxed) {
        0 => Mode::Off,
        1 => Mode::On,
        _ => Mode::Verify,
    }
}

pub(crate) fn set_mode(mode: Mode) {
    MODE.store(mode as u8, Ordering::Relaxed);
}

struct Context {
    colors: ColorContext,
    lengths: LengthContext,
    reads: ColorReads,
    refinement: StyleRefinement,
}

struct Entry {
    /// A weak reference keeps the allocation, so the address the entry is keyed by cannot be given
    /// to another style while the entry lives, and does not keep the style.
    style: Weak<StyleDesc>,
    contexts: Vec<Context>,
}

#[derive(Default)]
struct Cache {
    entries: FxHashMap<usize, Entry>,
}

impl Cache {
    fn insert(&mut self, style: &Arc<StyleDesc>, context: Context) {
        if self.entries.len() >= LIMIT && !self.entries.contains_key(&(Arc::as_ptr(style) as usize)) {
            self.entries.retain(|_, entry| entry.style.strong_count() > 0);
            if self.entries.len() >= LIMIT {
                self.entries.clear();
            }
        }
        let entry = self
            .entries
            .entry(Arc::as_ptr(style) as usize)
            .or_insert_with(|| Entry { style: Arc::downgrade(style), contexts: Vec::new() });
        if entry.contexts.len() >= CONTEXTS {
            entry.contexts.clear();
        }
        entry.contexts.push(context);
    }

    fn find(&self, style: &StyleDesc, colors: &ColorContext, lengths: &LengthContext) -> Option<&Context> {
        self.entries
            .get(&(style as *const StyleDesc as usize))?
            .contexts
            .iter()
            .find(|context| context.colors == *colors && context.lengths == *lengths)
    }
}

thread_local! {
    static CACHE: RefCell<Cache> = RefCell::new(Cache::default());
}

/// A borrow of a refinement as the element `apply_styles` styles.
struct Sink<'a>(&'a mut StyleRefinement);

impl Styled for Sink<'_> {
    fn style(&mut self) -> &mut StyleRefinement {
        self.0
    }
}

fn computed(style: &StyleDesc, colors: &ColorContext, lengths: &LengthContext) -> (StyleRefinement, ColorReads) {
    let mut refinement = StyleRefinement::default();
    let (_, reads) = colors.watch_reads(|| {
        crate::renderer::apply_styles(Sink(&mut refinement), style, colors, lengths);
    });
    (refinement, reads)
}

/// `renderer::apply_styles(el, style, colors, lengths)` for an element whose style is still the
/// default, which a freshly made host `div` is: the refinement of the step is laid over it, which
/// is what the step does when it sets the fields one by one.
///
/// `shared` is the style table's `Arc` of the element: `style` is the one the step is run for, and
/// it is found by its identity only when it is that `Arc`'s own value.
pub(crate) fn apply<E: Styled>(
    mut el: E,
    shared: Option<&Arc<StyleDesc>>,
    style: &StyleDesc,
    colors: &ColorContext,
    lengths: &LengthContext,
) -> E {
    let mode = mode();
    // A declaration that reads custom properties is applied from what they say at the element, which
    // the address of the style does not name; the build resolves it to a fresh style, never to this one.
    let shared = shared.filter(|shared| {
        mode != Mode::Off && std::ptr::eq(Arc::as_ptr(shared), style) && style.var_declarations.is_none()
    });
    let Some(shared) = shared else {
        return crate::renderer::apply_styles(el, style, colors, lengths);
    };
    let replayed = CACHE.with_borrow(|cache| {
        let kept = cache.find(style, colors, lengths)?;
        if mode == Mode::Verify {
            let (fresh, reads) = computed(style, colors, lengths);
            assert!(
                fresh == kept.refinement && reads == kept.reads,
                "the style cache kept a style that is applied differently now\n kept {:?} ({:?})\n now  {:?} ({:?})\n for {style:?}",
                kept.refinement,
                kept.reads,
                fresh,
                reads,
            );
        }
        if kept.reads == ColorReads::Own {
            colors.note_read();
        }
        el.style().refine(&kept.refinement);
        Some(())
    });
    if replayed.is_some() {
        crate::perf_counters::style_applied(true);
        return el;
    }
    crate::perf_counters::style_applied(false);
    // The read the step noted is the element's own, as if the step had run on it.
    let (refinement, reads) = computed(style, colors, lengths);
    el.style().refine(&refinement);
    if reads != ColorReads::Other {
        CACHE.with_borrow_mut(|cache| cache.insert(shared, Context { colors: *colors, lengths: *lengths, reads, refinement }));
    }
    el
}

#[cfg(test)]
mod tests {
    use super::*;

    fn style(json: &str) -> Arc<StyleDesc> {
        Arc::new(serde_json::from_str(json).unwrap())
    }

    fn applied(shared: &Arc<StyleDesc>, colors: &ColorContext, lengths: &LengthContext) -> StyleRefinement {
        let mut refinement = StyleRefinement::default();
        apply(Sink(&mut refinement), Some(shared), shared, colors, lengths);
        refinement
    }

    #[test]
    fn a_style_is_applied_once_for_the_contexts_it_is_applied_in() {
        set_mode(Mode::On);
        let shared = style(r#"{"width":"2em","backgroundColor":"currentColor","border":"1px solid red"}"#);
        let colors = ColorContext::root(crate::color::Scheme::Light);
        let small = LengthContext::initial(800.0, 600.0);
        let kept = applied(&shared, &colors, &small);
        let before = crate::perf_counters::snapshot();
        assert_eq!(applied(&shared, &colors, &small), kept);
        let replayed = crate::perf_counters::snapshot();
        assert_eq!(replayed.style_applies_replayed, before.style_applies_replayed + 1);
        let _ = applied(&shared, &colors, &LengthContext::initial(400.0, 600.0));
        let after = crate::perf_counters::snapshot();
        assert_eq!(after.style_applies_computed, replayed.style_applies_computed + 1, "another viewport is another context");
    }

    #[test]
    fn a_style_that_is_not_the_element_s_own_is_applied_every_time() {
        set_mode(Mode::On);
        let shared = style(r#"{"width":10}"#);
        let other = StyleDesc::clone(&shared);
        let colors = ColorContext::root(crate::color::Scheme::Light);
        let lengths = LengthContext::initial(800.0, 600.0);
        let before = crate::perf_counters::snapshot();
        for _ in 0..2 {
            let mut refinement = StyleRefinement::default();
            apply(Sink(&mut refinement), Some(&shared), &other, &colors, &lengths);
        }
        let after = crate::perf_counters::snapshot();
        assert_eq!(after.style_applies_replayed, before.style_applies_replayed);
        assert_eq!(after.style_applies_computed, before.style_applies_computed);
    }

    #[test]
    fn a_full_cache_lets_go_of_the_styles_nothing_holds() {
        let mut cache = Cache::default();
        let kept = style(r#"{"width":1}"#);
        let colors = ColorContext::root(crate::color::Scheme::Light);
        let lengths = LengthContext::initial(800.0, 600.0);
        let context = |reads| Context { colors, lengths, reads, refinement: StyleRefinement::default() };
        cache.insert(&kept, context(ColorReads::None));
        for _ in 0..LIMIT - 1 {
            cache.insert(&style(r#"{"height":1}"#), context(ColorReads::None));
        }
        assert_eq!(cache.entries.len(), LIMIT);
        cache.insert(&style(r#"{"height":2}"#), context(ColorReads::None));
        assert_eq!(cache.entries.len(), 2, "the styles that were dropped are gone, the one still held stays");
        assert!(cache.find(&kept, &colors, &lengths).is_some());
    }
}
