/*
 * Stack of open modal layers (direct children of <body>). The top layer is
 * the only interactive one: every other body child is made `inert`, except
 * live regions marked `data-live-layer` (toasts), and <html> gets
 * `has-modal` to lock page scrolling.
 */

const stack: HTMLElement[] = [];
/** Elements this module made inert, so only those are restored. */
const inertedByStack = new WeakSet<Element>();

function sync() {
  const top = stack.length > 0 ? stack[stack.length - 1]! : null;
  for (const child of Array.from(document.body.children)) {
    const shouldBeInert = top !== null && child !== top && !child.hasAttribute("data-live-layer");
    if (shouldBeInert) {
      if (!child.hasAttribute("inert")) {
        child.setAttribute("inert", "");
        inertedByStack.add(child);
      }
    } else if (inertedByStack.has(child)) {
      child.removeAttribute("inert");
      inertedByStack.delete(child);
    }
  }
  document.documentElement.classList.toggle("has-modal", top !== null);
}

/** Registers `layer` as the new top dialog; the returned function removes it. */
export function pushDialog(layer: HTMLElement): () => void {
  stack.push(layer);
  sync();
  let popped = false;
  return () => {
    if (popped) return;
    popped = true;
    const index = stack.lastIndexOf(layer);
    if (index !== -1) stack.splice(index, 1);
    sync();
  };
}

export function isTopDialog(layer: HTMLElement | null): boolean {
  return layer !== null && stack.length > 0 && stack[stack.length - 1] === layer;
}
