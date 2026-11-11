export interface ToggleEventInit extends EventInit {
  oldState?: string
  newState?: string
}

/** What `beforetoggle` and `toggle` carry: the popover's state before the change and after it, `"closed"` or `"open"`. */
export class ToggleEvent extends Event {
  readonly oldState: string
  readonly newState: string

  constructor(type: string, init: ToggleEventInit = {}) {
    super(type, init)
    this.oldState = init.oldState ?? ""
    this.newState = init.newState ?? ""
  }
}
