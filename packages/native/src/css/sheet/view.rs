//! The retained tree as something selectors match against.

use std::borrow::Cow;

use crate::retained_tree::{RetainedElement, RetainedTree};

use super::atoms::Atom;
use super::matching::ElementView;

#[derive(Clone, Copy)]
pub struct TreeView<'a> {
    tree: &'a RetainedTree,
    id: u64,
}

impl<'a> TreeView<'a> {
    pub fn new(tree: &'a RetainedTree, id: u64) -> Self {
        TreeView { tree, id }
    }

    fn element(&self) -> &'a RetainedElement {
        self.tree.elements.get(&self.id).expect("a view is made of an element that exists")
    }
}

impl ElementView for TreeView<'_> {
    fn tag(&self) -> Option<Atom> {
        self.tree.sheets.atoms.tag(&self.element().element_type)
    }

    fn id(&self) -> Option<Atom> {
        self.element().css().and_then(|css| css.id)
    }

    fn has_class(&self, class: Atom) -> bool {
        self.element().css().is_some_and(|css| css.classes.contains(&class))
    }

    fn attr(&self, name: Atom) -> Option<Cow<'_, str>> {
        let sheets = &self.tree.sheets;
        if name == sheets.style {
            let element = self.element();
            let own = element.own_style()?;
            let raw = self.tree.styles.raw_of(own).expect("an own style comes from StyleTable::intern");
            return Some(Cow::Owned(sheets.style_text(own, &raw).to_string()));
        }
        self.element().attribute(sheets.atoms.name(name))
    }

    fn parent(&self) -> Option<Self> {
        let parent = self.element().parent?;
        Some(TreeView { tree: self.tree, id: parent })
    }

    fn prev_sibling(&self) -> Option<Self> {
        let parent = self.tree.elements.get(&self.element().parent?)?;
        let position = parent.children.iter().position(|child| *child == self.id)?;
        parent.children[..position]
            .iter()
            .rev()
            .find(|sibling| self.tree.elements.get(sibling).is_some_and(RetainedElement::is_matchable))
            .map(|sibling| TreeView { tree: self.tree, id: *sibling })
    }

    fn is_root(&self) -> bool {
        self.tree.root_id == Some(self.id)
    }
}
