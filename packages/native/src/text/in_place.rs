//! A borrow that stands for a gpui element through a chain of builder calls.
//!
//! A `Div` is 1.7 KB and a `Canvas` 1.5 KB, and every builder call (`relative()`, `child(..)`, `unlifted()`)
//! takes the element by value and returns it, which is a copy in and a copy out. `selectable_text` makes
//! about a hundred of them per frame in a window of rows, ten calls each. The same calls on an [`InPlace`]
//! move eight bytes. See [`crate::slot`], which does this for the host element.

use gpui::{AnyElement, InteractiveElement, Interactivity, ParentElement, StyleRefinement, Styled};

pub(super) struct InPlace<'a, T>(&'a mut T);

impl<'a, T> InPlace<'a, T> {
    pub(super) fn new(element: &'a mut T) -> Self {
        Self(element)
    }
}

impl<T: Styled> Styled for InPlace<'_, T> {
    fn style(&mut self) -> &mut StyleRefinement {
        self.0.style()
    }
}

impl<T: InteractiveElement> InteractiveElement for InPlace<'_, T> {
    fn interactivity(&mut self) -> &mut Interactivity {
        self.0.interactivity()
    }
}

impl<T: ParentElement> ParentElement for InPlace<'_, T> {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.0.extend(elements)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::{div, Div};

    #[test]
    fn a_chain_on_the_borrow_moves_eight_bytes_and_not_the_element() {
        assert_eq!(std::mem::size_of::<InPlace<Div>>(), std::mem::size_of::<usize>());
        assert!(std::mem::size_of::<Div>() > 1024);
    }

    #[test]
    fn a_chain_on_the_borrow_builds_what_the_chain_on_the_element_builds() {
        let mut in_place = div();
        InPlace::new(&mut in_place)
            .relative()
            .unlifted()
            .child(div())
            .children([div(), div()]);
        let mut by_value = div()
            .relative()
            .unlifted()
            .child(div())
            .children([div(), div()]);
        assert_eq!(format!("{:?}", in_place.style()), format!("{:?}", by_value.style()));
    }
}
