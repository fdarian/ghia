//! The `@layer` tree of one document.
//!
//! A layer's position in the cascade is not the order it was first named in: sublayers of `a`
//! rank below the styles written directly in `a`, and all of `a` ranks below a later sibling. So
//! a rule keeps a [`LayerId`] (stable as layers are added by later sheets) and the cascade asks
//! [`Layers::order`] for the ranks when it builds its index.

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct LayerId(u32);

struct Node {
    name: Option<Box<str>>,
    children: Vec<LayerId>,
}

#[derive(Default)]
pub struct Layers {
    nodes: Vec<Node>,
    roots: Vec<LayerId>,
}

impl Layers {
    /// The layer `name` directly inside `parent` (the top level for `None`), created at the end of
    /// its siblings when it is new.
    pub fn declare(&mut self, parent: Option<LayerId>, name: &str) -> LayerId {
        let siblings = match parent {
            Some(parent) => &self.nodes[parent.0 as usize].children,
            None => &self.roots,
        };
        let existing = siblings
            .iter()
            .find(|sibling| self.nodes[sibling.0 as usize].name.as_deref() == Some(name));
        match existing {
            Some(existing) => *existing,
            None => self.add(parent, Some(name.into())),
        }
    }

    /// A layer no other `@layer` can name again.
    pub fn anonymous(&mut self, parent: Option<LayerId>) -> LayerId {
        self.add(parent, None)
    }

    fn add(&mut self, parent: Option<LayerId>, name: Option<Box<str>>) -> LayerId {
        let id = LayerId(u32::try_from(self.nodes.len()).expect("fewer than 2^32 layers"));
        self.nodes.push(Node { name, children: Vec::new() });
        match parent {
            Some(parent) => self.nodes[parent.0 as usize].children.push(id),
            None => self.roots.push(id),
        }
        id
    }

    pub fn order(&self) -> LayerOrder {
        let mut ranks = vec![0; self.nodes.len()];
        let mut next = 0;
        for root in &self.roots {
            self.rank_subtree(*root, &mut ranks, &mut next);
        }
        LayerOrder { ranks, unlayered: next }
    }

    fn rank_subtree(&self, layer: LayerId, ranks: &mut [u32], next: &mut u32) {
        for child in &self.nodes[layer.0 as usize].children {
            self.rank_subtree(*child, ranks, next);
        }
        ranks[layer.0 as usize] = *next;
        *next += 1;
    }
}

/// Cascade ranks for normal declarations: a higher rank wins, and unlayered styles outrank every
/// layer. Important declarations compare the other way round.
pub struct LayerOrder {
    ranks: Vec<u32>,
    unlayered: u32,
}

impl LayerOrder {
    pub fn rank(&self, layer: Option<LayerId>) -> u32 {
        match layer {
            Some(layer) => self.ranks[layer.0 as usize],
            None => self.unlayered,
        }
    }
}
