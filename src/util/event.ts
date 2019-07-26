export class SimpleEventListener<Ts extends any[]> {
	private readonly eventTarget = new EventTarget() // requires Firefox 59+
	private static readonly defaultType = 'event'

	listen(fn: (...args: Ts) => unknown, type = SimpleEventListener.defaultType) {
		const handler = (event: Event) => { fn(...(event as CustomEvent<Ts>).detail) }
		const { eventTarget } = this
		eventTarget.addEventListener(type, handler)
		return { destroy() { eventTarget.removeEventListener(type, handler) } }
	}

	dispatchWithType(type: string, ...args: Ts) {
		return this.eventTarget.dispatchEvent(new CustomEvent(type, { detail: args }))
	}

	dispatch(...args: Ts) {
		return this.dispatchWithType(SimpleEventListener.defaultType, ...args)
	}
}