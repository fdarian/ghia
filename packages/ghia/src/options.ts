export interface RunOptions {
  /** The Vite config file, an absolute path or relative to the working directory; Vite looks in `root` for `vite.config.*` when it is absent. */
  configFile?: string
  /** The project root, an absolute path or relative to the working directory; defaults to the working directory. */
  root?: string
  /** The app entry, resolved against the Vite root. It replaces the `entry` option of `ghia()`. */
  entry?: string
}

export interface BuildOptions extends RunOptions {
  /** Compile `dist/main.js` (and `dist/server.js`) into one executable that embeds Bun and the native addon, about 128 MB. Defaults to true. */
  compile?: boolean
}
