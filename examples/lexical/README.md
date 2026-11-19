# Lexical example

Two small rich-text editors, the same document and the same look, written the way one writes them for Chrome: real `lexical` 0.53,
CSS in a stylesheet (`editor.css`); the apps are plain web code apart from the `testId` props the automation check finds elements by. They run on Ghia's [editing hosts](../../docs/fork/editing.md).

| | Entry | Lexical API |
|---|---|---|
| React | `main.react.tsx` (`app.react.tsx`) | `LexicalComposer`, `RichTextPlugin`, `HistoryPlugin`, `ListPlugin`, `LinkPlugin`, `AutoFocusPlugin` from `@lexical/react` |
| Solid | `main.solid.tsx` (`app.solid.tsx`) | the vanilla API: `createEditor`, `registerRichText`, `registerHistory`, `registerList`, a `TOGGLE_LINK_COMMAND` handler |

Both show a top toolbar (undo, redo, bold, italic, underline, strikethrough, code, H1, H2, paragraph, quote, bulleted and numbered
list, link) whose active states follow the selection, a link bar (the Link button opens a URL field), a placeholder, and a
**floating format toolbar** over a non-collapsed selection. The floating toolbar is positioned from
`window.getSelection().getRangeAt(0).getBoundingClientRect()` the way the Lexical playground's `FloatingTextFormatToolbarPlugin` does: absolutely
positioned, 10px above the selection (below it when there is no room), clamped to the editor (`floating.ts`). `editor-config.ts` (nodes,
theme, seed), `format.ts` (what the selection is in, the commands), `floating.ts` and `icons.ts` are shared by both apps.

## Open it

```sh
cd examples
bun run lexical          # ghia dev lexical/main.react.tsx
bun run lexical:solid    # ghia dev lexical/main.solid.tsx
bun run lexical:inspector  # the editor state JSON, the selection and the undo depth printed beside a bare editor
```

Leave the session running; an edit is a Fast Refresh (React) or hot (Solid) update. Ghia needs a release addon
(`cd packages/native && bun run build`), a debug one looks like lag.

## Check them with the automation client

```sh
cd examples
bun lexical/apps.automation.ts react
bun lexical/apps.automation.ts solid
bun lexical/inspector.automation.ts      # the bare editor: clicks, drags, Option+Backspace, undo, scrolling
```

Each opens its own window in the background (`GPUIX_BACKGROUND=1`, no focus taken), drives it through the automation API and prints a
PASS or FAIL line per step. `apps.automation.ts` types a sentence, selects a word with Option+Shift+Left, checks that the floating toolbar is
visible, above the word and 5px left of it, presses Bold in it (a `<strong>`), undoes and redoes, makes a bulleted list and puts a link on a word.
The protocol has no `eval`, so it reads the painted tree (tags, text, bounds), and the screenshot for the markers of the list items (a bullet or a number is no element: it is ink in front of the item). Screenshots go to `lexical/screens/` (gitignored, 2x on a Retina display).

## Known gaps on Ghia

The automation protocol cannot do these, so they are for you to try by hand:

- **Double click** a word, then **triple click** a paragraph (the protocol sends every press with a click count of 1). Then Cmd+B.
- **Typing through AppKit**: real keys, key repeat (hold a letter), Shift+arrows, Option+Left/Right/Backspace, Cmd+Left/Right,
  Cmd+Backspace, Cmd+A, Cmd+Z and Cmd+Shift+Z. Typing a run of letters should be one undo step.
- **Dead keys**: Option+E then E (é), Option+U then U (ü), Option+N then N (ñ). Nothing should be inserted until the second key.
- **Japanese (or any) IME**: switch to Hiragana, type `nihon`, watch the underlined composition, press Space to convert and Enter
  to commit; Esc must cancel it. The candidate window should sit under the composition.
- **Emoji picker**: Ctrl+Cmd+Space, pick one. **Dictation**: Fn twice (or the menu), speak.
- **Trackpad drag-select**: drag across paragraphs and past the panel's edges (the panel should scroll), drag backwards, and
  drag from the empty paragraph. Click in the empty paragraph and type.
- **The toolbars by hand** (either app): double click a word and the floating toolbar appears over it, and drag-select across lines and it
  stays hidden until the button is released; press B, I, U in it and in the top toolbar (the selection must stay and the active states
  must follow the caret); Cmd+B, Cmd+Z and Cmd+Shift+Z; click Link, type a URL, press Return; with the caret in a link, the Link button
  removes it; in an empty document the placeholder shows.
- **Bold with the button** (the inspector): select text, click B (the selection must stay), click B again.
- **Copy and paste, with Chrome and TextEdit.** Cmd+C in the editor, then Cmd+V into TextEdit (rich text), a Chrome page with a `contenteditable` and
  the Lexical playground: the text arrives, bold stays bold, and a copy from the Lexical playground pastes here with its formatting (the
  `application/x-lexical-editor` type travels in Chrome's custom-data format). Paste text from TextEdit and a web page too. Cmd+X cuts, Cmd+A selects
  all.
- **Edit menu.** Cut, Copy, Paste and Select All are enabled with and without a focused editor, run the same commands as the keys, and show their
  shortcuts. Undo and Redo are not in the menu yet (Cmd+Z works as a key).
