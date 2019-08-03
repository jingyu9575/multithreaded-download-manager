import { mapInsert } from "../util.js";
import { SimpleEventListener } from "../event.js";

export class LocalSettings<T extends object> {
	readonly data: Readonly<T>
	readonly initialization: Promise<void>

	// EventTarget
	private listeners = new Map<keyof T, SimpleEventListener<[any]>>()

	constructor(data: T) {
		this.data = data
		this.initialization = browser.storage.local.get().then(
			v => { Object.assign(data, v) })
		browser.storage.onChanged.addListener((changes, areaName) => {
			if (areaName !== 'local') return
			for (const key in changes) {
				Object.assign(data, { [key]: changes[key].newValue })
				const listener = this.listeners.get(key as keyof T)
				try {
					if (listener) listener.dispatch(data[key as keyof T])
				} catch { }
			}
		})
	}

	post(data: Partial<T>) { return browser.storage.local.set(data) }

	listen<K extends keyof T>(key: K, fn: (value?: T[K]) => void, skipCall?: 'skip') {
		const result = mapInsert(this.listeners, key,
			() => new SimpleEventListener).listen(fn)
		if (!skipCall) this.initialization.then(() => fn(this.data[key]))
		return result
	}
}

export class RemoteSettings<T extends object> {
	constructor(private readonly sharedPrototype: T) { }

	async load(keys: (keyof T)[] | null = null) {
		const result = await browser.storage.local.get(keys as any) as Readonly<T>
		Object.setPrototypeOf(result, this.sharedPrototype)
		return result
	}

	async get<K extends keyof T>(key: K) { return (await this.load([key]))[key] }
	async set(data: Partial<T>) { await browser.storage.local.set(data as any) }
}
