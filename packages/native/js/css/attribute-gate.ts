/**
 * Whether a renderer's native tree is told the DOM attributes of its elements.
 *
 * Nothing in native reads an attribute but the stylesheet cascade, and an element's attributes cost
 * a wire op each, so an app with no sheet sends none. The gate of a renderer opens, for good, the
 * first time a sheet can apply (a `<style>` element is created, a sheet is sent), and each queue of
 * the renderer then sends the attributes of the elements it already holds.
 */

/** What a queue offers the gate: sending the attributes of the elements it holds. */
export interface AttributeGateMember {
  backfillAttributes(): void
}

interface Gate {
  open: boolean
  readonly members: Set<WeakRef<AttributeGateMember>>
}

const gates = new WeakMap<object, Gate>()

function gateOf(renderer: object): Gate {
  let gate = gates.get(renderer)
  if (!gate) {
    gate = { open: false, members: new Set() }
    gates.set(renderer, gate)
  }
  return gate
}

export function attributesForwarded(renderer: object): boolean {
  return gates.get(renderer)?.open === true
}

export function registerAttributeGateMember(renderer: object, member: AttributeGateMember): void {
  gateOf(renderer).members.add(new WeakRef(member))
}

/**
 * Opens the gate of `renderer`: from now on the attributes are sent, and every queue of the renderer
 * first sends the ones its elements have. A no-op once open.
 */
export function openAttributeGate(renderer: object): void {
  const gate = gateOf(renderer)
  if (gate.open) return
  gate.open = true
  for (const ref of [...gate.members]) {
    const member = ref.deref()
    if (member) member.backfillAttributes()
    else gate.members.delete(ref)
  }
}
