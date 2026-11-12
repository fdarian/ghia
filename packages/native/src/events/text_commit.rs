//! What a text control has to commit with a `change` event.
//!
//! HTML fires `change` when the user commits a value the control did not have when the last commit
//! (or a write from script) left it: on blur and, in a single-line `<input>`, on Enter. The control
//! reports each edit here, and the two places that commit, the editor's Enter and the blur that
//! `focus.rs` notices, take what is pending. It is shared through `InputRouting`, which the editor
//! and the view both hold and neither has to lease the other for; the retained tree would deadlock
//! the editor, which writes it while the frame that holds the tree's lock builds it.

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use gpui::{App, Window};

use crate::element_tree::EventPayload;
use crate::renderer::EventCallback;
use crate::retained_tree::RetainedTree;

use super::keyboard::InputRouting;
use super::sync_dispatch;

struct Commit {
    /// The value at the last commit, or the one a script wrote last, or the one the control was made with.
    committed: String,
    /// The value now, while it is not `committed`.
    edited: Option<String>,
}

#[derive(Default)]
pub(crate) struct TextCommits(RefCell<HashMap<u64, Commit>>);

impl TextCommits {
    /// A script wrote `value`, and an edit before it is not one the user has left to commit.
    pub(crate) fn written(&self, id: u64, value: &str) {
        self.0
            .borrow_mut()
            .insert(id, Commit { committed: value.to_string(), edited: None });
    }

    /// The user's edit made the value `value`. Typing a character and deleting it again leaves nothing to commit.
    pub(crate) fn edited(&self, id: u64, value: &str) {
        let mut commits = self.0.borrow_mut();
        let commit = commits
            .entry(id)
            .or_insert_with(|| Commit { committed: String::new(), edited: None });
        commit.edited = (commit.committed != value).then(|| value.to_string());
    }

    /// Commits the value if the user changed it, and returns it.
    pub(crate) fn commit(&self, id: u64) -> Option<String> {
        let mut commits = self.0.borrow_mut();
        let commit = commits.get_mut(&id)?;
        let value = commit.edited.take()?;
        commit.committed = value.clone();
        Some(value)
    }

    pub(crate) fn forget(&self, id: u64) {
        self.0.borrow_mut().remove(&id);
    }
}

/// The `change` of a commit that left `id` with `value`, aimed at it with its path, or `None` when
/// nobody on the path listens for it.
pub(crate) fn change_payload(tree: &RetainedTree, id: u64, value: String) -> Option<EventPayload> {
    if !super::path::path_listens(tree, id, "change") {
        return None;
    }
    Some(EventPayload {
        element_id: id as f64,
        event_type: "change".to_string(),
        target: Some(id as f64),
        path: Some(super::path::event_path(tree, id).into_iter().map(|id| id as f64).collect()),
        value: Some(value),
        ..Default::default()
    })
}

/// Enter in an `<input>`: commits `id` and delivers the `change` before returning, so a handler has run by
/// the time the form is submitted.
pub(crate) fn deliver_commit(
    routing: &InputRouting,
    tree: &Arc<Mutex<RetainedTree>>,
    callback: &Option<EventCallback>,
    id: u64,
    window: &mut Window,
    cx: &mut App,
) {
    let Some(value) = routing.text_commits().commit(id) else {
        return;
    };
    let payload = change_payload(&tree.lock().unwrap(), id, value);
    if let Some(payload) = payload {
        sync_dispatch::emit(window, cx, callback, payload);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_value_the_user_changed_commits_once() {
        let commits = TextCommits::default();
        commits.written(1, "a");
        commits.edited(1, "ab");
        assert_eq!(commits.commit(1).as_deref(), Some("ab"));
        assert_eq!(commits.commit(1), None);
    }

    #[test]
    fn an_edit_that_is_undone_commits_nothing() {
        let commits = TextCommits::default();
        commits.written(1, "a");
        commits.edited(1, "ab");
        commits.edited(1, "a");
        assert_eq!(commits.commit(1), None);
    }

    #[test]
    fn the_next_edit_is_measured_from_the_last_commit() {
        let commits = TextCommits::default();
        commits.written(1, "");
        commits.edited(1, "a");
        commits.commit(1);
        commits.edited(1, "ab");
        commits.edited(1, "a");
        assert_eq!(commits.commit(1), None);
    }

    #[test]
    fn a_write_from_script_drops_the_pending_edit() {
        let commits = TextCommits::default();
        commits.written(1, "");
        commits.edited(1, "a");
        commits.written(1, "A");
        assert_eq!(commits.commit(1), None);
    }
}
