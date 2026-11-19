# Lexical editor example

A rich-text editor (Lexical's `RichTextPlugin`, `HistoryPlugin` and a Bold button) in a scrollable panel, with the editor state JSON,
the selection and the undo depth printed beside it, live. It is real `lexical` and `@lexical/react`, unchanged, on Ghia's
[editing hosts](../../docs/fork/editing.md).

## Open it

```sh
cd examples
bun run lexical          # ghia dev lexical/editor.main.tsx
```

Leave the session running; an edit to `editor.tsx` is a Fast Refresh update. Ghia needs a release addon
(`cd packages/native && bun run build`), a debug one looks like lag.

## Check it with the automation client

```sh
cd examples
bun lexical/editor.automation.ts
```

Opens its own window in the background (`GPUIX_BACKGROUND=1`, no focus taken), drives it through the automation API and prints a
PASS, FAIL or SKIP line per step. Screenshots go to `lexical/screens/` (gitignored, 2x on a Retina display).
`LEXICAL_TIMING=1` prints how long each key press took.

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
- **Bold with the button**: select text, click B (the selection must stay), click B again.
- **Copy and paste, with Chrome and TextEdit.** Cmd+C in the editor, then Cmd+V into TextEdit (rich text), a Chrome page with a `contenteditable` and
  the Lexical playground: the text arrives, bold stays bold, and a copy from the Lexical playground pastes here with its formatting (the
  `application/x-lexical-editor` type travels in Chrome's custom-data format). Paste text from TextEdit and a web page too. Cmd+X cuts, Cmd+A selects
  all.
- **Edit menu.** Cut, Copy, Paste and Select All are enabled with and without a focused editor, run the same commands as the keys, and show their
  shortcuts. Undo and Redo are not in the menu yet (Cmd+Z works as a key).
