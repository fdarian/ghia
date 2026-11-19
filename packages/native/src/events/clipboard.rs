//! Copy, cut, paste and select all as GPUI actions, and where they go when no text control has the
//! focus.
//!
//! One set of actions serves the keys (Cmd+C, X, V and A; Ctrl off macOS), the Edit menu
//! (`app_menu.rs`) and `<input>`/`<textarea>` (`custom_elements/input.rs` binds the same actions in
//! its own context and handles them first, on the focus path). What reaches the window's root
//! element is the page's: it is sent to JS as the internal `clipboardcommand` event
//! (`js/editing/clipboard-commands.ts` fires the DOM clipboard event and does Chrome's default),
//! and JS reports whether it did the command.
//!
//! A window with nothing focused is not on the path of the root element's handlers, so an
//! app-level listener forwards the action to the window (`forward`).
//!
//! The keydown comes first: JS hears it before GPUI looks the key up, and a `preventDefault` on it
//! stops the key there, so the command never runs, as in Chrome. The menu only fires when the key
//! was not handled (`docs/fork/window.md`).
//!
//! A copy JS did not do falls back to the painted-text selection a drag made, which JS does not
//! hold (the node selection and the painted one never exist together).

use gpui::{actions, Action, App, ClipboardItem, Div, InteractiveElement as _, KeyBinding, Window};

use crate::renderer::EventCallback;
use crate::text::SharedSelection;

actions!(
    gpuix_clipboard,
    [
        /// Copy the selection to the clipboard.
        Copy,
        /// Copy the selection, then remove it.
        Cut,
        /// Insert the clipboard at the selection.
        Paste,
        /// Select everything the focused editing host, or the page, holds.
        SelectAll,
    ]
);

/// The internal event a command reaches JS as. It is not a DOM event: no listener hears it, and
/// `value` names the command.
pub const CLIPBOARD_COMMAND_EVENT: &str = "clipboardcommand";

#[derive(Clone, Copy, PartialEq, Eq)]
enum Command {
    Copy,
    Cut,
    Paste,
    SelectAll,
}

impl Command {
    fn name(self) -> &'static str {
        match self {
            Command::Copy => "copy",
            Command::Cut => "cut",
            Command::Paste => "paste",
            Command::SelectAll => "selectAll",
        }
    }
}

/// Binds the shortcuts, in no key context: an `<input>` has its own bindings of the same actions
/// and, with the focus in it, handles them before the window does. Call it before
/// `app_menu::init`, which reads the key equivalents of the menu items out of the keymap.
pub(crate) fn init(cx: &mut App) {
    let modifier = if cfg!(target_os = "macos") { "cmd" } else { "ctrl" };
    cx.bind_keys([
        KeyBinding::new(&format!("{modifier}-c"), Copy, None),
        KeyBinding::new(&format!("{modifier}-x"), Cut, None),
        KeyBinding::new(&format!("{modifier}-v"), Paste, None),
        KeyBinding::new(&format!("{modifier}-a"), SelectAll, None),
    ]);
    cx.on_action(|_: &Copy, cx| forward(Command::Copy, cx));
    cx.on_action(|_: &Cut, cx| forward(Command::Cut, cx));
    cx.on_action(|_: &Paste, cx| forward(Command::Paste, cx));
    cx.on_action(|_: &SelectAll, cx| forward(Command::SelectAll, cx));
}

/// What a window with nothing focused does with an action. The dispatch path of such a window is
/// the one node of the view that holds the root element, which the root element's handlers
/// (`with_actions`) are not on, so the command would be unavailable: the keys would do nothing and
/// the Edit menu would be greyed out. A global listener is on every path last, and counts for
/// `App::is_action_available`; it only sees the `App`, so it runs the command on the window the
/// menu belongs to, once the dispatch that holds that window is over.
fn forward(command: Command, cx: &mut App) {
    let Some(window) = command_window(cx) else { return };
    cx.defer(move |cx| {
        let result = window.update(cx, |_, window, cx| {
            let view = match super::sync_dispatch::root_view(window) {
                Ok(view) => view,
                Err(error) => {
                    super::sync_dispatch::report_deferred_error(error);
                    return;
                }
            };
            let (selection, callback) = {
                let view = view.read(cx);
                (view.selection.clone(), view.event_callback.clone())
            };
            run(command, &selection, &callback, window, cx);
        });
        if let Err(error) = result {
            super::sync_dispatch::report_deferred_error(error.to_string());
        }
    });
}

/// The main window, or the one window the app has when macOS names none (the app is not active, or
/// the window is offscreen).
fn command_window(cx: &App) -> Option<gpui::AnyWindowHandle> {
    cx.active_window().or_else(|| {
        let mut windows = cx.windows().into_iter();
        let only = windows.next()?;
        windows.next().is_none().then_some(only)
    })
}

/// The root element's handlers: what no focused element took.
pub(crate) fn with_actions(
    root: Div,
    selection: SharedSelection,
    callback: Option<EventCallback>,
) -> Div {
    root.on_action(handler::<Copy>(Command::Copy, &selection, &callback))
        .on_action(handler::<Cut>(Command::Cut, &selection, &callback))
        .on_action(handler::<Paste>(Command::Paste, &selection, &callback))
        .on_action(handler::<SelectAll>(Command::SelectAll, &selection, &callback))
}

fn handler<A: Action>(
    command: Command,
    selection: &SharedSelection,
    callback: &Option<EventCallback>,
) -> impl Fn(&A, &mut Window, &mut App) + 'static {
    let selection = selection.clone();
    let callback = callback.clone();
    move |_, window, cx| run(command, &selection, &callback, window, cx)
}

fn run(
    command: Command,
    selection: &SharedSelection,
    callback: &Option<EventCallback>,
    window: &mut Window,
    cx: &mut App,
) {
    let outcome = super::sync_dispatch::emit_full(
        window,
        cx,
        callback,
        0,
        CLIPBOARD_COMMAND_EVENT,
        |payload| payload.value = Some(command.name().to_string()),
    );
    if command == Command::Copy && !outcome.handled {
        copy_painted_selection(selection, cx);
    }
}

fn copy_painted_selection(selection: &SharedSelection, cx: &mut App) {
    // The lock is released before the platform clipboard is entered.
    let text = selection.lock().selected_text();
    if let Some(text) = text {
        cx.write_to_clipboard(ClipboardItem::new_string(text));
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use gpui::{Action as _, AppContext as _};

    use super::*;
    use crate::element_tree::EventPayload;
    use crate::renderer::GpuixView;
    use crate::retained_tree::RetainedTree;

    /// A window with one empty element and nothing focused, and the events its view sends.
    fn window_with_nothing_focused(
        cx: &mut gpui::TestAppContext,
    ) -> (gpui::AnyWindowHandle, Arc<Mutex<Vec<EventPayload>>>) {
        let tree = Arc::new(Mutex::new(RetainedTree::new()));
        {
            let mut tree = tree.lock().unwrap();
            tree.create_element(1, "div".to_owned());
            tree.set_root(1);
        }
        let events = Arc::new(Mutex::new(Vec::new()));
        let sent = events.clone();
        let callback: EventCallback = Arc::new(move |payload| sent.lock().unwrap().push(payload));
        cx.update(init);
        let window = cx.add_window(|window, _| {
            crate::events::enable_dom_hit_testing(window);
            crate::layout::container::allow_redraw_passes(window);
            GpuixView::new(
                tree,
                Some(callback),
                "test".to_owned(),
                SharedSelection::default(),
                crate::events::state::PointerRequests::default(),
            )
        });
        cx.update_window(window.into(), |_, window, app| {
            window.refresh();
            window.draw(app).clear(app);
        })
        .unwrap();
        (window.into(), events)
    }

    fn all() -> [(&'static str, Box<dyn gpui::Action>); 4] {
        [
            ("copy", Copy.boxed_clone()),
            ("cut", Cut.boxed_clone()),
            ("paste", Paste.boxed_clone()),
            ("selectAll", SelectAll.boxed_clone()),
        ]
    }

    #[gpui::test]
    fn the_edit_menu_items_are_enabled_with_nothing_focused(cx: &mut gpui::TestAppContext) {
        let (window, _) = window_with_nothing_focused(cx);
        cx.update_window(window, |_, window, app| {
            assert!(window.focused(app).is_none());
            for (name, action) in all() {
                assert!(
                    app.is_action_available(action.as_ref()),
                    "{name} is not available to a window with nothing focused"
                );
            }
        })
        .unwrap();
    }

    #[gpui::test]
    fn a_command_with_nothing_focused_reaches_the_page(cx: &mut gpui::TestAppContext) {
        let (window, events) = window_with_nothing_focused(cx);
        for (name, action) in all() {
            cx.update_window(window, |_, window, app| window.dispatch_action(action, app))
                .unwrap();
            cx.run_until_parked();
            let events = events.lock().unwrap();
            let last = events.last().expect("an event for the command");
            assert_eq!(last.event_type, CLIPBOARD_COMMAND_EVENT);
            assert_eq!(last.value.as_deref(), Some(name));
        }
    }
}
