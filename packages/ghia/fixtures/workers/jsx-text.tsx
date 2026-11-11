// The Worker call is the text of an element: no Worker, and no such file.
export const h = (_tag: string, _props: null, ...children: unknown[]) => children
export const view = <p>new Worker(new URL("./does-not-exist.ts", import.meta.url))</p>
