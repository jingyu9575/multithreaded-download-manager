interface AbortSignal extends EventTarget {
	readonly aborted: boolean
	onabort: () => void
}

declare class AbortController {
	signal: AbortSignal
	abort(): void
}

interface RequestInit {
	signal?: AbortSignal
}

interface IDBObjectStore {
	getAll(query?: IDBKeyRange | IDBValidKey, count?: number): IDBRequest
	getAllKeys(query?: IDBKeyRange | IDBValidKey, count?: number): IDBRequest
}

interface IDBIndex {
	getAll(query?: IDBKeyRange | IDBValidKey, count?: number): IDBRequest
}

interface IDBDatabase {
	createMutableFile(name: string, type: string): IDBRequest
}

declare namespace browser.webRequest {
	function filterResponseData(requestId: string): StreamFilter

	interface ResponseDataFilterEventMap {
		start: {}
		data: { data: ArrayBuffer }
		stop: {}
		error: {}
	}

	interface StreamFilter extends EventTarget {
		status: ('uninitialized' | 'transferringdata' | 'suspended' |
			'disconnected' | 'closed' | 'finishedtransferringdata')

		error?: Error

		onstart: (event: {}) => void
		ondata: (event: { data: ArrayBuffer }) => void
		onstop: (event: {}) => void
		onerror: (event: {}) => void

		write(data: ArrayBuffer | Uint8Array): void
		suspend(): void
		resume(): void
		disconnect(): void
		close(): void

		addEventListener<K extends keyof ResponseDataFilterEventMap>(type: K,
			listener: (ev: ResponseDataFilterEventMap[K]) => any): void
		addEventListener(type: string, listener: EventListener): void
	}
}

declare class TextDecoder {
	constructor(label?: string, options?: { fatal?: boolean, ignoreBOM: boolean })
	readonly encoding: string
	readonly fatal: boolean
	readonly ignoreBOM: boolean
	decode(input?: ArrayBuffer | ArrayBufferView,
		options?: { stream?: boolean }): string
}

declare function escape(str: string): string