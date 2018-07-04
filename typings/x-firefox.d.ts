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

interface Navigator {
	storage: StorageManager
}

interface StorageManager {
	persist(): Promise<boolean>
}

interface IDBFactory {
	deleteDatabase(name: string, options: { storage: string }): IDBOpenDBRequest;
}