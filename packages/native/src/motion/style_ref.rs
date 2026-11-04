//! A style that motion reads, either shared with the style table or built for this frame.

use std::sync::Arc;

use crate::style::StyleDesc;

/// `StyleDesc` is several kilobytes, so a stage that keeps a style (a transition's
/// before-change style, the declared style of a frame) keeps the table's `Arc` when it was
/// handed one, and copies only when it was handed a borrow.
#[derive(Clone, Copy)]
pub(crate) enum StyleRef<'a> {
    Shared(&'a Arc<StyleDesc>),
    Borrowed(&'a StyleDesc),
}

impl StyleRef<'_> {
    /// The style as something that outlives the borrow: a pointer clone when it is shared.
    pub(crate) fn share(self) -> Arc<StyleDesc> {
        match self {
            Self::Shared(shared) => Arc::clone(shared),
            Self::Borrowed(style) => Arc::new(style.clone()),
        }
    }

    /// Whether this is `shared` itself, so the two are equal without comparing them.
    pub(crate) fn is(&self, shared: &Arc<StyleDesc>) -> bool {
        matches!(self, Self::Shared(own) if Arc::ptr_eq(own, shared))
    }
}

impl std::ops::Deref for StyleRef<'_> {
    type Target = StyleDesc;

    fn deref(&self) -> &StyleDesc {
        match self {
            Self::Shared(shared) => shared,
            Self::Borrowed(style) => style,
        }
    }
}

impl<'a> From<&'a Arc<StyleDesc>> for StyleRef<'a> {
    fn from(shared: &'a Arc<StyleDesc>) -> Self {
        Self::Shared(shared)
    }
}

impl<'a> From<&'a StyleDesc> for StyleRef<'a> {
    fn from(style: &'a StyleDesc) -> Self {
        Self::Borrowed(style)
    }
}
