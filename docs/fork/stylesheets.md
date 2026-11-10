# Stylesheets

How CSS rules reach an element: `<style>` elements and constructed sheets, the rule parser, the rule index, matching, the cascade at the level of declarations, and what a change to the tree or a sheet marks to match again. The behaviour an app author sees is in [reference](../reference.md#stylesheets), the differences from CSS in [deviations](deviations.md#stylesheets).

The code is `packages/native/src/css/sheet/` (parse, match, cascade, invalidate; `tree.rs` is the retained tree's side) and `packages/native/js/css/` (the CSSOM). `renderer.rs`, `retained_tree.rs` and `host.ts` only call into them.

## The shape

Ghia has one way to style an element, a JSON object of declarations (`StyleTable::intern`, the style prop). A sheet does not add a second one: a rule's declarations are turned into the same JSON text, merged with the element's own text, and interned as one style. The cascade is therefore a merge of declaration lists, and everything that makes a style prop work (lenient parsing of a bad value, `var()` held until the build, shorthands covering longhands, retention, transitions) works for a sheet with no code of its own.

```
sheet text ──parse──> rules (selectors + normal/important declarations + layer + order)
                          │
                    validate declarations, index by rightmost compound
                          │
element (tag, id, classes, attributes) ──match──> MatchedRules (interned)
                          │
MatchedRules + own style declarations ──merge──> JSON text ──StyleTable::intern──> Arc<StyleDesc>
                          │
                    RetainedElement::style (what the build, retention and getComputedStyle read)
```

No sheet at all is a branch: every hook of the tree returns at `StyleSheets::enabled`, which is false until a `<style>` element or a constructed sheet exists and false again once the last is gone (`wind_down_sheets` frees the atoms, index and per-element data).

## Parsing a sheet

`parser.rs` reads a token list (`tokenizer.rs`, a small CSS tokenizer; there is no `cssparser` crate in the lockfile) into a `StyleSheet`: a list of `Rule`, each with its selector list (every selector with its specificity), its normal and `!important` declarations, its `@layer` and its source `order`.

- **Declarations** keep the form the style prop has: the property name from kebab to camelCase (`--x` verbatim, `-webkit-user-select` to `WebkitUserSelect`), the value as CSS text with comments and whitespace runs collapsed, `!important` split off. A bare number for a property in the lenient parser's `UNITLESS` list is written as a JSON number, everything else as a JSON string. A declaration without a colon or with an empty value is skipped as CSS skips it.
- **Nesting.** A rule inside a style block is parsed with the parent's selectors as its `Nesting::Parent`; `&` becomes `:is(parent list)`, and a relative selector (`.b`, `> .b`) gets an implicit `&` in front. The parent's declarations written before the nested rule are one rule, those after it another, so source order is kept.
- **Layers** (`layers.rs`). `@layer a, b;`, `@layer a { }` and `@layer { }` create nodes in a tree owned by the document, not the sheet: a name is declared where it is first mentioned, in any sheet. `Layers::order()` gives each node a rank so that the sublayers of `a` rank below `a`'s own styles and all of `a` below a later sibling; unlayered styles rank above every layer. That is why every sheet is parsed again when one changes: ranks depend on every sheet's first mentions.
- **What is skipped.** Any other at-rule is skipped with its block and recorded in `StyleSheet::unsupported`, which `StyleSheets::load` logs once. An invalid selector list drops its rule.

### Selectors

`selector_parse.rs` and `selector.rs`. A `ComplexSelector` is compounds joined by combinators, stored with the subject first (`compounds[0]`, matched right to left). Simple selectors are type, universal, class, id, attribute (seven operators, `i` and `s`), `:is()`, `:where()`, `:not()`, `:root`, `:host` and the pseudo-element marker. Specificity follows Selectors 4 (`:is` and `:not` take their most specific argument, `:where` none; a nested `&` takes the parent's `:is`). A selector list is all or nothing, except inside `:is()` and `:where()`, which skip an invalid member; `:not()` is not forgiving.

### Atoms

`atoms.rs`. Tags, ids, class names and attribute names are interned to a `u32` once per document, so matching compares integers. The parser lower-cases tags and attribute names and keeps classes and ids as written. Every element's `ElementCss` holds its tag, id and class atoms while sheets exist; they are computed for all existing elements at the first flush after a sheet appears (`atoms_fresh`) and kept current by the hooks after that.

### Validation

`validate.rs`. The cascade merges declarations before any style is parsed, so a declaration that cannot parse must be removed first, or `right: bogus !important` would erase an inline `right`. `Validator::filter` judges each declaration once, when its sheet is loaded, by the check `StyleTable::intern` runs on a style: it must parse to a style that is not empty. Custom properties, `var()` values and CSS-wide keywords are accepted without a check (the first two are only known at build time, the keyword is the cascade's own). A key the style does not know parses to the empty style and is dropped, as CSS drops an unknown property. Verdicts are cached by the declaration's JSON text, bounded at 4096. A rule left with no declaration is dropped.

## The rule index and matching

`index.rs`. `RuleIndex::build` numbers the rules in cascade source order (sheet by sheet) and puts each selector of each rule in one bucket, chosen by the most selective thing its subject compound requires: an id, else a class, else an attribute name, else a tag, else the universal list. A rule whose selectors are all pseudo-element selectors is left out.

`RuleIndex::matching(element)` visits the buckets of the element's id, its classes, every attribute name some selector reads (and the element has), its tag, and the universal list, runs the full right-to-left match (`matching.rs`, over the `ElementView` trait; `view.rs` is the retained tree's implementation) on each candidate, and sorts the matches by (layer rank, specificity, source number). A rule counts once, at the specificity of the most specific of its selectors that matched.

`TreeView::attr` reads an attribute from the element's attribute store (`attributes.rs`, set by wire op 13) and, failing that, from the prop of the same name (`id`, `role`, `aria-*` arrive as props). `style` is special: the text is synthesized from the element's own style declarations (`kebab-key: value;`, cached per own-style `Arc` while any selector reads `style`, `StyleSheets::style_text`), so `[style*="--dnd-scale"]` works. A text node (a `text` element holding a string) is not matchable.

### Matched sets are interned

`cascade.rs`. The result of matching is a `MatchedRules`: the rule numbers in the order their normal declarations apply and the rules with important declarations in the order those apply (layers compare the other way round there: the first layer wins, unlayered rules lose). Equal match lists are interned by a table of weak references (`MatchedInterner`, pruned when it doubles), so a thousand `.item` elements hold one `Arc` and are compared and cached by its pointer.

## The cascade

`cascade::merge` works on declarations as the style prop's JSON would hold them:

1. the normal declarations of each matched rule, in `matched.normal` order;
2. the element's own declarations, in written order (`StyleTable::raw_of` gives the own style's JSON, read back with the lenient parser's `Declarations`);
3. the important declarations of each rule in `matched.important` order.

A later declaration of a key removes the earlier one and is appended, which is where `css/covers.rs` reads "written order" from when the merged text is interned: a shorthand drops the longhands before it, a longhand after it stays. A CSS-wide keyword (`apply`) removes the key and the longhands it covers from what came before and appends nothing. The merged text goes through `StyleTable::intern` and the universal layer (`<UniversalStyle>`) is put under the result exactly as for an element with no sheet match (`refresh_effective_style`). A merge whose text does not parse leaves the element its own style and is logged.

### The cascade cache

`CascadeCache`, `StyleTable::cascaded`: keyed by (matched `Arc` pointer, own style `Arc` pointer) and holding strong references to both, so addresses cannot be reused while an entry lives. N elements that match the same rules and share an own style cost one merge (`cascadesComputed` counts the misses). The cache is cleared when the sheets change; `release_unused` drops entries whose style only the cache and the style table hold, so the table can sweep it. No sheet matches an element: its effective style is the own style, the same `Arc`, and the cache is not asked.

## What a change marks

`invalidation.rs`. When the index is built, `Invalidation::read` walks every selector and records, per feature, where a change of that feature can alter a match, as a `Reach`: nine bits, `{the element, its next sibling, all following siblings} x {itself, its children, everything below}`.

A feature (a class atom, an id atom, an attribute name, and `style`) sits in some compound of a selector. The elements the selector styles are reached from the compound by the combinators to its right: a descendant or child combinator reaches the subtree (children, or everything below), `+` the next sibling, `~` the following siblings, and a sibling combinator followed by a descendant one the subtrees of those siblings. A feature in the subject compound reaches just the element. Features inside `:is`, `:where` and `:not` take the position of the compound that holds them, and an argument with combinators of its own is read through them and then through the rest of the selector. `structure` is the reach of an element appearing or disappearing among its siblings (non-empty only when a sibling combinator exists). A feature no selector names has no entry: a change to it marks nothing.

The tree's hooks (`tree.rs`) collect `(element, Reach)` marks:

| Change | Mark |
|---|---|
| class attribute (symmetric difference of the atom sets, plus the reach of `[class]`), `id`, any other attribute, `id`/`role`/`aria-*` prop | the reach of what changed |
| own style change | the reach of `[style]`, which is empty unless a selector reads it |
| element inserted or moved | the element and its subtree, plus `structure` |
| element about to be removed | the next matchable sibling, with `structure`, since what follows matches without it |
| text of a `<style>` element, `<style>` inserted, removed or moved, root changed, constructed sheet changed or the adopted list changed | the sources are dirty: every element matches again |

### The flush

`flush_styles`, called once at the end of `apply_batch_to_tree`, after the last op, so a batch matches each element once however many ops touched it:

1. If the sources are dirty, `reload_sheets`: collect the texts of the connected `<style>` elements in tree order (`tree_path` compares positions among siblings), then the adopted constructed sheets in list order. If they equal the texts the index was built from nothing happens; otherwise `StyleSheets::load` parses all of them again with one `Atoms` and one `Layers`, validates, builds the index, clears the interner and the cascade cache and marks everything.
2. If the atoms are not fresh, compute them for every element and mark everything.
3. Expand the marks into the set of elements to match (`restyle_set`, `Expansion`): each reach becomes the element, its children or its subtree, and the next or following siblings, each element once and each subtree walked once. A mark of everything is the document in tree order plus the elements outside it (which match nothing).
4. Match each (`elementsRematched` counts them), intern the result, and compare it to the element's current `matched` by pointer.
5. `apply_matched` for the ones that changed: store `matched`, `refresh_effective_style`, `settle_style_change`. That is the path `set_style` takes, so retention, the transition source style and the paragraph grouping see an ordinary style change.
6. Drop what is unused (`[style]` texts, cascade entries), and wind down if no sheet is left.

An element that is not in the document, or is not matchable, matches nothing: removing a `<style>` element restores every element it styled.

## Sheet sources

- **`<style>` elements.** An element of type `style` registers in `style_elements` when created. Its sheet text is the concatenation of its `text` children. It takes part while connected to the root, in tree order. `display` reads `none` for it (`RetainedElement::display`), so layout skips it and the build never draws it. Solid lists `style` as an element type (`isElementType`) and React's host config forwards any type and a string child becomes a text element as anywhere.
- **Constructed sheets**, wire ops 14 and 15 (`batch/wire.rs`, `BatchOp::SetStyleSheet`, `SetAdoptedStyleSheets`). `constructed` maps a sheet id to its text; `adopted` is the ordered list that applies, after the `<style>` elements. A sheet in the map and not in the list does nothing. Sheet ids are a namespace of their own.

## Attributes and wire ops 13 to 15

Op 13 `setAttribute(id, name, value | null)` stores into the element's attribute store; the JS adapters forward `class`, every `data-*` and any other primitive attribute (see [reference](../reference.md#listeners-and-dom-members-on-an-element)). Ops 14 and 15 carry the constructed sheets. All three are in the binary batch (`js/wire.ts`, `WIRE_OPCODE`) and decoded by `wire-testing.ts` for the tests. Layout of each is in [reference](../reference.md#wire-format).

## The JS side

`packages/native/js/css/`, framework neutral:

- `rules.ts` splits sheet text into top-level rules (strings, comments, escapes, parentheses and nested braces; an at-rule ends at its block or a `;`, a style rule only at its block, as in the native parser). It does not interpret a rule. `CSSStyleSheet.cssRules` lists what it finds.
- `style-sheet.ts`: `CSSStyleSheet`, `CSSRule`, `CSSStyleRule`, `CSSRuleList`. Every change to the rule list calls `sheetChanged`, which sends the whole text (`sheetText()`: the rule texts joined by newlines).
- `observable-array.ts`: a `Proxy` over an array that checks every value (`convert`) and reports once per change; the mutating methods are wrapped so they are one change, not one per element they touch.
- `adopted.ts`: `document.adoptedStyleSheets`, one array for the document.
- `sheet-sync.ts`: what reaches native. Sheets are per native tree, so there is one record per renderer (not per queue): the ids of the sheets whose text it holds and the adopted list it holds. `registerSheetSink(renderer, queue)` is called by `createMutationQueue`, which is how a renderer mounted after sheets were adopted gets them. A change computes what each renderer lacks: `setStyleSheet(id, text)` for a sheet it has not seen or whose text changed, `setAdoptedStyleSheets(ids)` when the list differs from the one sent (a sheet listed twice counts at its last place, a disabled sheet is left out), and `setStyleSheet(id, null)` for a sheet that left the list. The ops go through any live queue of the renderer, so they ride in its next batch like every other op.

## Counters

`getBuildCounters()` on the test renderer: `elementsRematched` (elements matched against the rules by a flush) and `cascadesComputed` (cascade cache misses). A class toggle on one of fifty items reads 1 for `elementsRematched`; the guard is in `packages/solid/src/__tests__/stylesheet.test.tsx`.

## Tests

- Rust, `packages/native/src/css/sheet/tests.rs` (parser, selectors, specificity, layers, nesting, the dnd-kit text) and `tree_tests.rs` (matching, cascade with inline styles, invalidation reach per combinator, sources, ops, the flush).
- JS, `packages/native/js/__tests__/css-stylesheet.test.ts`: the splitter, `insertRule` and `deleteRule`, `replace`, the observable array and the ops each change sends to a fake renderer.
- Solid and React, `stylesheet.test.tsx`: classes, attributes, `<style>` text and removal, the match counters. Solid, `dnd-kit-stylesheets.test.tsx`: the three sheets of `@dnd-kit/dom` 0.5.3 (`src/css/sheet/fixtures/dnd-kit.css`), as `<style>` elements and as adopted sheets, against a dragged item, a placeholder and an overlay. It reads `cursor`, `user-select` and `pointer-events` from the test renderer's `getElement(id).style`, since `getComputedStyle` answers a fixed list of properties, and `top`/`left` from the laid-out box.
