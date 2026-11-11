//! The state of an `<input>` that is not its props: what a script assigns to `checked`,
//! `defaultChecked`, `indeterminate` and a range's `value`, and the restore of a controlled control
//! to the props its framework committed.
//!
//! These are renderer calls and not mutation-batch ops: they change the tree's own state
//! (`Choices`, `Ranges`) and never `custom_props`, which hold what a framework committed. Each ends
//! by making the window draw what changed, without leasing the root view, so a handler can make them.

use std::sync::{Arc, Mutex};

use gpui::{App, Window};

use super::sync_dispatch;
use crate::retained_tree::RetainedTree;

fn changing(
    tree: &Arc<Mutex<RetainedTree>>,
    window: &mut Window,
    cx: &mut App,
    change: impl FnOnce(&mut RetainedTree) -> Result<(), String>,
) -> Result<(), String> {
    let dirty = {
        let mut tree = tree.lock().unwrap();
        change(&mut tree)?;
        tree.take_dirty()
    };
    let view = sync_dispatch::root_view(window)?;
    crate::renderer::invalidate_after_mutation(window, cx, view.entity_id(), dirty);
    Ok(())
}

/// `input.checked = flag`, and `defaultChecked` and `indeterminate` the same way.
pub(crate) fn write_flag(
    tree: &Arc<Mutex<RetainedTree>>,
    id: u64,
    name: &str,
    flag: bool,
    window: &mut Window,
    cx: &mut App,
) -> Result<(), String> {
    changing(tree, window, cx, |tree| tree.script_wrote_flag(id, name, flag))
}

/// `input.value = text` on a range, which sanitizes it as a read does.
pub(crate) fn write_range_value(
    tree: &Arc<Mutex<RetainedTree>>,
    id: u64,
    text: &str,
    window: &mut Window,
    cx: &mut App,
) -> Result<(), String> {
    changing(tree, window, cx, |tree| tree.script_wrote_range_value(id, text))
}

/// React DOM's `restoreControlledState` for the control `id`: it shows the `checked` or `value`
/// prop that was committed.
pub(crate) fn restore_controlled(
    tree: &Arc<Mutex<RetainedTree>>,
    id: u64,
    window: &mut Window,
    cx: &mut App,
) -> Result<(), String> {
    changing(tree, window, cx, |tree| {
        tree.restore_controlled(id);
        Ok(())
    })
}
