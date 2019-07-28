import { abortError, readOnlyError } from "./error.js";

export class SimpleStorage {
	// Bug 1193394 fixed in Firefox 60 (Promise invalidates IDBRequest)

	private database!: IDBDatabase

	static request<T>(r: IDBRequest<T>) {
		return new Promise<T>((resolve, reject) => {
			r.addEventListener('success', () => resolve(r.result))
			r.addEventListener('error', () => reject(r.error))
			r.addEventListener('abort', () => reject(abortError()))
		})
	}

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
		that.database = await SimpleStorage.request(request) as IDBDatabase
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
		return SimpleStorage.request<T>(this.objectStore('readonly').get(key))
	}

	getAll(range: IDBKeyRange) {
		return SimpleStorage.request(this.objectStore('readonly').getAll(range))
	}

	keys() {
		return SimpleStorage.request(this.objectStore('readonly').getAllKeys())
	}

	set(key: IDBValidKey, value: unknown) {
		return SimpleStorage.request(this.objectStore('readwrite').put(value, key))
	}

	async insert<T>(key: IDBValidKey, fn: () => T) {
		const store = this.objectStore('readwrite')
		const cursor = await SimpleStorage.request(
			store.openCursor(key)) as IDBCursorWithValue
		if (cursor) return cursor.value as T
		const value = fn()
		await store.add(value, key)
		return value
	}

	delete(key: IDBValidKey | IDBKeyRange) {
		return SimpleStorage.request(this.objectStore('readwrite').delete(key))
	}

	mutableFile(filename: string, type = 'application/octet-stream') {
		return SimpleStorage.request(this.database.createMutableFile(filename, type))
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
		return SimpleStorage.request(handle.write(data))
	}

	read(size: number, location: number) {
		const handle = this.open()
		handle.location = location
		return SimpleStorage.request(handle.readAsArrayBuffer(size))
	}

	truncate(start?: number) {
		const handle = this.open()
		return SimpleStorage.request(handle.truncate(start))
	}

	flush() {
		const handle = this.open()
		return SimpleStorage.request(handle.flush())
	}

	getFile() {
		return SimpleStorage.request(this.mutableFile.getFile())
	}
}
