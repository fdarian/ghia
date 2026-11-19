// What a bundler for the web build gets in place of `parse5.js` (`browser` in package.json): a page
// has its own DOMParser and innerHTML, Ghia's are never installed there, and nothing in the bundle
// then carries parse5.

export function parse5() {
  throw new Error("The web build has no HTML parser of its own: the page's DOMParser and innerHTML are the browser's.")
}

export function isParse5Loaded() {
  return false
}
