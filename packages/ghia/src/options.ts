export interface RunOptions {
  /** The Vite config file, an absolute path or relative to the working directory; Vite looks in `root` for `vite.config.*` when it is absent. */
  configFile?: string
  /** The project root, an absolute path or relative to the working directory; defaults to the working directory. */
  root?: string
}
