//! The title a view last gave its platform window, so that `render` sets it only when it changed: the platform call is an
//! AppKit `setTitle` and an accessibility update.

/// The title a view last gave its platform window.
#[derive(Default)]
pub(crate) struct AppliedWindowTitle(Option<String>);

impl AppliedWindowTitle {
    /// `wanted` when the window does not have it yet, recording it as applied.
    pub(crate) fn to_apply<'a>(&mut self, wanted: &'a str) -> Option<&'a str> {
        if self.0.as_deref() == Some(wanted) {
            return None;
        }
        self.0 = Some(wanted.to_owned());
        Some(wanted)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_first_title_and_a_changed_one_are_applied() {
        let mut applied = AppliedWindowTitle::default();
        assert_eq!(applied.to_apply("first"), Some("first"));
        assert_eq!(applied.to_apply("second"), Some("second"));
        assert_eq!(applied.to_apply("first"), Some("first"));
    }

    #[test]
    fn the_title_the_window_already_has_is_not_applied_again() {
        let mut applied = AppliedWindowTitle::default();
        applied.to_apply("title");
        assert_eq!(applied.to_apply("title"), None);
        assert_eq!(applied.to_apply("title"), None);
    }

    #[test]
    fn an_empty_title_is_applied_once() {
        let mut applied = AppliedWindowTitle::default();
        assert_eq!(applied.to_apply(""), Some(""));
        assert_eq!(applied.to_apply(""), None);
    }
}
