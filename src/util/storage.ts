import { abortError, readOnlyError } from "./error.js";

export function idbRequest<T>(r: IDBRequest<T>) {
	// Bug 1193394 fixed in Firefox 60 (Promise invalidates IDBRequest)
	return new Promise<T>((resolve, reject) => {
		r.addEventListener('success', () => resolve(r.result))
		r.addEventListener('error', () => reject(r.error))
		r.addEventListener('abort', () => reject(abortError()))
	})
}

export function idbTransaction(r: IDBTransaction) {
	return new Promise<void>((resolve, reject) => {
		r.addEventListener('complete', () => resolve())
		r.addEventListener('error', () => reject(r.error))
		r.addEventListener('abort', () => reject(abortError()))
	})
}

export async function* idbCursorRequest<T extends IDBCursor>(
	r: IDBRequest<T | null>
) {
	let resolve: () => void
	let reject: (reason?: any) => void
	r.addEventListener('error', () => reject(r.error))
	r.addEventListener('abort', () => reject(abortError()))
	r.addEventListener('success', () => resolve())
	for (; ;) {
		await new Promise<void>((newResolve, newReject) => {
			resolve = newResolve; reject = newReject
		})
		const cursor = r.result
		if (!cursor) break
		yield cursor
		cursor.continue()
	}
}

export class SimpleStorage {
	private database!: IDBDatabase

	private constructor(private readonly objectStoreName: string) { }

	static async create(databaseName = 'simpleStorage', {
		version = undefined as number | undefined,
		objectStoreName = 'simpleStorage',
		migrate = async () => { },
	} = {}) {
		const that = new this(objectStoreName)
		const request = indexedDB.open(databaseName, version)
		request.onupgradeneeded = async event => {
			const db = request.result as IDBDatabase
			that.currentObjectStore = event.oldVersion ?
				request.transaction!.objectStore(objectStoreName) :
				db.createObjectStore(objectStoreName)
			await migrate()
		}
		that.database = await idbRequest(request) as IDBDatabase
		that.currentObjectStore = undefined
		return that
	}

	private currentObjectStore?: IDBObjectStore

	async transaction<T>(mode: 'readonly' | 'readwrite', fn: () => Promise<T>) {
		if (this.currentObjectStore) {
			if (this.currentObjectStore.transaction.mode == 'readonly'
				&& mode == 'readwrite')
				throw readOnlyError()
			return await fn()
		} else {
			this.currentObjectStore = this.objectStore(mode)
			try {
				return await fn()
			} finally { this.currentObjectStore = undefined }
		}
	}

	objectStore(mode: 'readonly' | 'readwrite') {
		if (this.currentObjectStore) return this.currentObjectStore
		return this.database.transaction(this.objectStoreName, mode)
			.objectStore(this.objectStoreName)
	}

	get<T>(key: IDBValidKey) {
		return idbRequest<T>(this.objectStore('readonly').get(key))
	}

	getAll(range: IDBKeyRange) {
		return idbRequest(this.objectStore('readonly').getAll(range))
	}

	keys() {
		return idbRequest(this.objectStore('readonly').getAllKeys())
	}

	entries(range: IDBKeyRange, mode: 'readonly' | 'readwrite') {
		return idbCursorRequest(this.objectStore(mode).openCursor(range))
	}

	set(key: IDBValidKey, value: unknown) {
		return idbRequest(this.objectStore('readwrite').put(value, key))
	}

	async insert<T>(key: IDBValidKey, fn: () => T) {
		const store = this.objectStore('readwrite')
		const cursor = await idbRequest(
			store.openCursor(key)) as IDBCursorWithValue
		if (cursor) return cursor.value as T
		const value = fn()
		await idbRequest(store.add(value, key))
		return value
	}

	delete(key: IDBValidKey | IDBKeyRange) {
		return idbRequest(this.objectStore('readwrite').delete(key))
	}

	clear() {
		return idbRequest(this.objectStore('readwrite').clear())
	}

	close() { this.database.close() }

	mutableFile(filename: string, type = 'application/octet-stream') {
		return idbRequest(this.database.createMutableFile(filename, type))
	}
}

export class SimpleMutableFile {
	static readonly isAvailable = 'IDBMutableFile' in window

	private cachedHandle?: IDBFileHandle

	constructor(readonly mutableFile: IDBMutableFile) { }

	private open() {
		if (!this.cachedHandle || !this.cachedHandle.active)
			this.cachedHandle = this.mutableFile!.open('readwrite')
		return this.cachedHandle
	}

	write(data: string | ArrayBuffer, location: number) {
		const handle = this.open()
		handle.location = location
		return idbRequest(handle.write(data))
	}

	read(size: number, location: number) {
		const handle = this.open()
		handle.location = location
		return idbRequest(handle.readAsArrayBuffer(size))
	}

	truncate(start?: number) {
		const handle = this.open()
		return idbRequest(handle.truncate(start))
	}

	flush() {
		const handle = this.open()
		return idbRequest(handle.flush())
	}

	getFile() {
		return idbRequest(this.mutableFile.getFile())
	}

	// Firefox 74 has removed IDBMutableFile.getFile (Bug 1607791)
	get requiresTempStorage() { return !this.mutableFile.getFile }

	async getFileWithTempStorage(tempStorage: SimpleStorage, prefix: string) {
		const SLICE_SIZE = 1024 * 1024 * 128
		const handle = this.open()
		const size = (await idbRequest(handle.getMetadata())).size
		const blobs: Blob[] = []
		for (let p = 0; p < size; p += SLICE_SIZE) {
			const key = [prefix, p]
			await tempStorage.set(key, new Blob([await this.read(SLICE_SIZE, p)]))
			blobs.push(await tempStorage.get(key))
		}
		return new File(blobs, this.mutableFile.name,
			{ type: this.mutableFile.type })
	}

	static cleanupTempStorage(tempStorage: SimpleStorage, prefix: string) {
		return tempStorage.delete(IDBKeyRange.bound([prefix], [prefix, []]))
	}
}
