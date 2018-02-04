const Log = console

class ExtendableError extends Error {
	constructor(message?: string) {
		super(message)
		this.name = new.target.name
	}
}

class AssertionError extends ExtendableError {
	constructor(message = 'assertion failed') { super(message) }
}

function assert(condition: any, message?: string) {
	if (!condition) throw new AssertionError(message)
}

function abortError() {
	return new DOMException("The operation was aborted. ", "AbortError")
}

class LocalizedError extends ExtendableError {
	constructor(msg: string, ...substitutions: any[]) {
		super(browser.i18n.getMessage(msg, substitutions.map(v => `${v}`)))
	}
	private _tagLocalizedError: never
}

class CriticalSection {
	private promise: Promise<any> = Promise.resolve()

	sync<T>(fn: () => T | PromiseLike<T>) { // fair, non-recursive
		const result = this.promise.then(fn)
		this.promise = result.then(() => { }, () => { })
		return result
	}
}

class Timer {
	private id?: number

	constructor(public onTimer: () => any, public defaultInterval = 0,
		public allowParallel = false) { }

	start(interval = this.defaultInterval) {
		this.stop()
		const id: number = setInterval(
			() => { if (this.id === id) this.dispatch() }, interval)
		this.id = id
	}

	startOnce(interval = this.defaultInterval) {
		this.stop()
		const id: number = setTimeout(() => {
			if (this.id !== id) return
			this.id = undefined
			this.dispatch()
		}, interval)
		this.id = id
	}

	stop() {
		if (this.id === undefined) return
		clearInterval(this.id) // clearTimeout, clearInterval are interchangeable
		this.id = undefined
	}

	get isStarted() { return this.id !== undefined }

	private parallelCount = 0

	private async dispatch() {
		if (!this.allowParallel && this.parallelCount) return
		this.parallelCount++
		try { await this.onTimer() } finally { this.parallelCount-- }
	}
}

const browserDownloadCrashErrors = new WeakSet<Error>()
const browserDownloadMap = new Map<number, Deferred<void>>()
function resolveBrowserDownload(id: number, error?: Error) {
	const deferred = browserDownloadMap.get(id)
	if (!deferred) return
	!error ? deferred.resolve() : deferred.reject(error)
	browserDownloadMap.delete(id)
}
browser.downloads.onChanged.addListener(({ id, state, error }) => {
	if (state && state.current === 'complete') resolveBrowserDownload(id)
	if (error && error.current) {
		const result = new LocalizedError('browserDownloadError', error.current)
		if (error.current === 'CRASH') browserDownloadCrashErrors.add(result)
		resolveBrowserDownload(id, result)
	}
})
browser.downloads.onErased.addListener(id => {
	resolveBrowserDownload(id, new LocalizedError('browserDownloadErased'))
})
function waitForBrowserDownload(id: number) {
	const deferred = new Deferred<void>()
	browserDownloadMap.set(id, deferred)
	return deferred.promise
}

class SimpleStorageOptions {
	readonly databaseName: string = 'simpleStorage'
	readonly storeName: string = 'simpleStorage'
	readonly persistent: boolean = true

	constructor(source: Partial<SimpleStorageOptions>) { Object.assign(this, source) }
}

class SimpleStorage extends SimpleStorageOptions {
	private database?: IDBDatabase
	readonly initialization: Promise<void>

	static request(r: IDBRequest) {
		return new Promise<any>((resolve, reject) => {
			r.onsuccess = () => resolve(r.result)
			r.onerror = () => reject(r.error)
		})
	}

	constructor(options: Partial<SimpleStorageOptions> = {}) {
		super(options)
		const request = indexedDB.open(this.databaseName,
			this.persistent ? { version: 1, storage: "persistent" } : 1 as any)
		request.onupgradeneeded = event => {
			const db = request.result as IDBDatabase
			db.createObjectStore(this.storeName)
		}
		this.initialization = SimpleStorage.request(request)
			.then(v => this.database = v)
	}

	async transaction(
		generator: (store: IDBObjectStore, db: IDBDatabase) => Iterator<IDBRequest>,
		mode: 'readonly' | 'readwrite' | 'nolock' = 'readwrite') {
		if (!this.database) await this.initialization
		return new Promise<any>((resolve, reject) => {
			const store = mode === 'nolock' ? undefined :
				this.database!.transaction(this.storeName, mode)
					.objectStore(this.storeName)
			const iterator = generator(store!, this.database!)
			function callNext(result: any) {
				const { value: request, done } = iterator.next(result)
				if (done) return resolve(request as any)
				request.addEventListener('success', () => callNext(request.result))
				request.addEventListener('error', () => reject(request.error))
			}
			callNext(undefined)
		})
	}

	get(key: IDBValidKey) {
		return this.transaction(function* (store) {
			return yield store.get(key)
		}, 'readonly')
	}

	getAll(range: IDBKeyRange): Promise<any[]> {
		return this.transaction(function* (store) {
			return yield store.getAll(range)
		}, 'readonly')
	}

	keys(): Promise<IDBValidKey[]> {
		return this.transaction(function* (store) {
			return yield store.getAllKeys()
		}, 'readonly')
	}

	set(key: IDBValidKey, value: any): Promise<void> {
		return this.transaction(function* (store) {
			return yield store.put(value, key)
		})
	}

	delete(key: IDBValidKey | IDBKeyRange): Promise<void> {
		return this.transaction(function* (store) {
			return yield store.delete(key)
		})
	}
}

class WritableFile {
	private mutableFile?: IDBMutableFile
	private readonly initialization: Promise<void>
	private size = 0
	private readonly mainThread = new CriticalSection()
	private readonly mergeThread = new CriticalSection()
	private pendingBlobCount = 0
	private nextId = 0

	private mergeKey(id: number) { return ['merge', this.filename, id] }
	private get mergeKeyRange() {
		return IDBKeyRange.bound(this.mergeKey(-Infinity), this.mergeKey(Infinity))
	}

	constructor(private readonly storage: SimpleStorage,
		private readonly filename: string, mode: 'create' | 'open') {
		this.initialization = (async () => {
			if (mode === 'open')
				this.mutableFile = await storage.get(filename)
			if (this.mutableFile) {
				const specs: WritableFile.MergeSpec[] =
					await storage.getAll(this.mergeKeyRange)
				for (const spec of specs) this.scheduleMerge(spec)
				if (specs.length) this.nextId = specs[specs.length - 1].id + 1
			} else {
				this.mutableFile = await storage.transaction(function* (_, db) {
					return yield db.createMutableFile(filename,
						'application/octet-stream')
				}, 'nolock')
				await storage.set(filename, this.mutableFile)
			}
		})()
	}

	private destroyed = false
	async destroy() {
		this.destroyed = true
		await this.storage.delete(this.filename)
		await this.storage.delete(this.mergeKeyRange)
	}

	private get handle() { return this.mutableFile!.open('readwrite') }

	private relaxedWrite(data: string | ArrayBuffer, location: number): Promise<void> {
		const that = this
		return this.storage.transaction(function* () {
			if (that.destroyed) return
			const { handle } = that
			handle.location = location
			yield handle.write(data)
			if (handle.location > that.size)
				that.size = handle.location
		}, 'nolock')
	}

	private static blobToArrayBuffer(blob: Blob) {
		return new Promise<ArrayBuffer>((resolve, reject) => {
			const fileReader = new FileReader()
			fileReader.onload = () => resolve(fileReader.result)
			fileReader.onerror = () => reject(fileReader.error)
			fileReader.readAsArrayBuffer(blob)
		})
	}

	private scheduleMerge({ id, blob, location }: WritableFile.MergeSpec) {
		this.pendingBlobCount++
		void this.mergeThread.sync(async () => {
			await this.relaxedWrite(
				await WritableFile.blobToArrayBuffer(blob), location)
			await this.storage.delete(this.mergeKey(id))
			this.pendingBlobCount--
		})
	}

	async write(data: string | ArrayBuffer, location: number) {
		if (!this.mutableFile) await this.initialization
		return this.mainThread.sync(async () => {
			if (location <= this.size && !this.pendingBlobCount)
				return await this.relaxedWrite(data, location)
			const id = this.nextId++
			const key = this.mergeKey(id)
			await this.storage.set(key,
				{ id, location, blob: new Blob([data]) } as WritableFile.MergeSpec)
			this.scheduleMerge(await this.storage.get(key))
		})
	}

	async relaxedRead(size: number, location: number): Promise<ArrayBuffer> {
		if (!this.mutableFile) await this.initialization
		return this.mainThread.sync(async () => {
			const that = this
			return this.storage.transaction(function* () {
				const { handle } = that
				handle.location = location
				return yield handle.readAsArrayBuffer(size)
			}, 'nolock')
		})
	}

	async getBlob<T>(callback: (blob: Blob) => T, truncateAt?: number): Promise<T> {
		if (!this.mutableFile) await this.initialization
		return this.mainThread.sync(() => this.mergeThread.sync(async () => {
			const that = this
			return this.storage.transaction(function* (): any {
				const { handle } = that
				if (truncateAt !== undefined)
					yield handle.truncate(truncateAt)
				return callback(yield handle.mutableFile.getFile())
			})
		}))
	}
}
namespace WritableFile {
	export interface MergeSpec { id: number, location: number, blob: Blob }
}

let taskStorage: SimpleStorage
let fileStorage: SimpleStorage

class TaskPersistentData extends TaskOptions {
	state: DownloadState = 'paused'
	error?: string = undefined
	totalSize?: number = undefined

	constructor(source: Partial<TaskPersistentData>) {
		super({})
		Object.assign(this, source)
	}
}

class Task extends TaskPersistentData {
	readonly id: number
	private readonly criticalSection = new CriticalSection()
	private file?: WritableFile
	private currentMaxThreads = 1
	private currentMaxRetries = 0
	private startTime?: Date
	private startSize = 0
	currentSize = 0
	private firstChunk?: Chunk
	private lastChunk?: Chunk
	threads = new Map<number, Thread>()
	fileAccessId?: number
	private isRangeSupported = true
	private isSavingDownload = false

	get totalSize() { return this.lastChunk ? this.lastChunk.initPosition : undefined }
	set totalSize(v) { } // used in base class

	private static nextId = 1
	static readonly list: Task[] = []
	static get(id: number) { return this.list.find(v => v.id === id) }
	static newTaskAtTop = false

	constructor(options: Partial<TaskPersistentData>, loadId?: number) {
		super(options)
		this.state = 'paused'
		this.id = loadId !== undefined ? loadId : Task.nextId++
		assert(!Task.get(this.id))
		if (Task.newTaskAtTop)
			Task.list.unshift(this)
		else
			Task.list.push(this)
		if (Task.nextId <= this.id) Task.nextId = this.id + 1

		broadcastRemote.update([[this.id, {
			url: this.url, filename: this.filename, referrer: this.referrer,
			state: this.state
		}]])
		const taskOrder = Task.list.map(v => v.id)
		void Settings.set({ taskOrder })
		broadcastRemote.setTaskOrder(taskOrder)
		void updateBadge()
		void this.criticalSection.sync(async () => {
			const keys = { maxThreads: 1, minChunkSize: 1, maxRetries: 1 }
			for (const key of Object.keys(keys) as (keyof typeof keys)[])
				if (this[key] === undefined)
					this[key] = await Settings.get(key)
			if (options.state !== 'completed') {
				this.file = new WritableFile(fileStorage,
					`${this.id}`, loadId === undefined ? 'create' : 'open')
				if (loadId === undefined)
					await fileStorage.delete(this.snapshotName)
			}
			if (options.totalSize !== undefined) {
				if (options.state === 'saving' || options.state === 'completed') {
					this.firstChunk = new Chunk(this, 0, undefined, undefined)
					this.lastChunk = new Chunk(this, options.totalSize,
						this.firstChunk, undefined)
					this.currentSize = this.firstChunk.currentSize = options.totalSize
				} else if (options.state &&
					DownloadState.canWriteChunks(options.state)) {
					await this.readChunks(options.totalSize)
				}
			}
			if (options.state === 'completed' || options.state === 'failed') {
				this.setState(options.state, true)
			} else if (options.state && DownloadState.isProgressing(options.state))
				this.start()
			if (loadId === undefined) void this.persist()
		})
	}

	private async persist() {
		const data = new TaskPersistentData({})
		for (const key of Object.keys(data) as (keyof TaskPersistentData)[])
			data[key] = this[key]
		await taskStorage.set(this.id, data)
	}

	async writeChunks() {
		await this.criticalSection.sync(async () => {
			if (!DownloadState.canWriteChunks(this.state)) return
			if (this.totalSize === undefined) return
			const data: number[] = [0]
			for (const chunk of this.getChunks())
				if (chunk.currentSize)
					data.push(chunk.initPosition, chunk.currentSize)
			data[0] = data.length - 1
			await this.file!.write(
				Float64Array.from(data).buffer as ArrayBuffer, this.totalSize)
		})
	}

	async readChunks(totalSize: number) {
		try {
			const nBytes = Float64Array.BYTES_PER_ELEMENT
			const size = new Float64Array(await this.file!
				.relaxedRead(nBytes, totalSize))[0]
			if (!size /* 0 | undefined */) return
			const data = Array.from(new Float64Array(await this.file!
				.relaxedRead(nBytes * size, totalSize + nBytes)))
			if (data.length !== size) return
			let chunk: Chunk | undefined = undefined
			let firstChunk: Chunk | undefined = undefined
			let currentSize = 0
			for (let i = 0; i < data.length; i += 2) {
				chunk = new Chunk(this, data[i], chunk, undefined)
				if (!firstChunk) firstChunk = chunk
				chunk.currentSize = data[i + 1]
				currentSize += chunk.currentSize
			}
			this.firstChunk = firstChunk
			this.lastChunk = new Chunk(this, totalSize, chunk, undefined)
			this.currentSize = currentSize
		} catch (error) { Log.warn('Task.readChunks failed', this.id, error) }
	}

	private setState(state: DownloadState, disableBadgeColor = false) {
		let canceled = false
		const isProgressing = DownloadState.isProgressing(state)
		if (DownloadState.isProgressing(this.state) !== isProgressing) {
			this.startTime =
				DownloadState.isProgressing(state) ? new Date() : undefined
			this.startSize = this.currentSize

			if (!isProgressing) {
				for (const thread of [...this.threads.values()]) thread.remove()
				if (this.firstChunk && state !== 'completed' &&
					(!this.lastChunk || !this.isRangeSupported)) {
					this.currentSize -= this.firstChunk.currentSize
					this.firstChunk = undefined
					this.lastChunk = undefined
					canceled = true
				}
			}
		}
		this.state = state
		broadcastRemote.update([[this.id, {
			state: this.state, error: this.error || '',
			fileAccessId: this.fileAccessId, canceled,
		}]])
		void updateBadge(disableBadgeColor ? undefined : this.state)
		void this.persist()
		void this.writeChunks()
	}

	start() {
		void this.criticalSection.sync(() => {
			if (!DownloadState.canStart(this.state)) return
			this.error = undefined
			this.currentMaxThreads = this.maxThreads!
			this.currentMaxRetries = this.maxRetries!
			this.setState('downloading')
			if (!writeChunksTimer.isStarted) {
				Log.log('writeChunksTimer.start')
				writeChunksTimer.start()
			}
			this.adjustThreads()
		})
	}

	setDetail(thread: Thread, filename: string, totalSize: number | undefined,
		acceptRanges: boolean) {
		void this.criticalSection.sync(() => {
			if (!this.firstChunk || this.firstChunk.thread !== thread) return
			assert(!this.firstChunk.next)
			if (!this.filename) this.filename = filename
			if (totalSize !== undefined) {
				this.lastChunk = new Chunk(this, totalSize, this.firstChunk, undefined)
				if (this.firstChunk.remainingSize <= 0) thread.remove()
			}
			this.isRangeSupported = acceptRanges && totalSize !== undefined
			broadcastRemote.update([[this.id, {
				filename: this.filename, totalSize: this.totalSize,
				pauseIsStop: !this.isRangeSupported,
			}]])
			void this.persist()
			this.adjustThreads()
		})
	}

	private adjustThreads() {
		if (this.state !== 'downloading') return
		if (!this.firstChunk) {
			assert(this.threads.size === 0)
			new Thread(this.firstChunk = new Chunk(this, 0, undefined, undefined))
		} else {
			if (this.currentMaxThreads > this.threads.size)
				this.addThreads()
			if (!this.threads.size) this.saveDownload()
		}
		broadcastRemote.update([[this.id, { threadCount: this.threads.size }]])
	}

	private *getChunks() { // [firstChunk, lastChunk)
		if (!this.firstChunk || !this.lastChunk) return
		for (let chunk = this.firstChunk!; chunk.next; chunk = chunk.next)
			yield chunk
	}

	private addThreads() {
		if (!this.isRangeSupported) return
		let quota = this.currentMaxThreads - this.threads.size
		if (quota <= 0) return
		assert(this.lastChunk)

		// first fill all the gaps
		const gaps = [] as { size: number, chunk: Chunk }[]
		for (const chunk of this.getChunks())
			if (!chunk.thread && chunk.remainingSize)
				gaps.push({ size: chunk.remainingSize, chunk })
		for (let i = 0; i < gaps.length && quota; i++)
			new Thread(gaps[i].chunk), quota--
		if (quota <= 0) return

		// then divide existing threads
		const divisibles = [...this.threads.values()].map(({ chunk }) =>
			({ size: chunk.remainingSize, chunk, count: 0 })).filter(v => v.size)
		if (!divisibles.length) return
		divisibles.sort((v0, v1) => v1.size - v0.size)

		const totalSize = divisibles.map(v => v.size).reduce((v0, v1) => v0 + v1)
		// (quota + gaps.length) is the number of the divided spaces
		// try to evenly distribute totalSize
		const invertSpaceSize = (quota + divisibles.length) / totalSize
		for (const divisible of divisibles) {
			divisible.count = Math.floor(divisible.size * invertSpaceSize - 1)
			quota -= divisible.count
		}

		// adjust the floored numbers to keep the sum.
		for (let i = divisibles.length; i-- > 0 && quota > 0;)
			++divisibles[i].count, --quota

		for (const divisible of divisibles) {
			// avoid too small chunks
			let spaceSize
			do {
				spaceSize = Math.floor(divisible.size / (divisible.count + 1))
				if (spaceSize > 0 && spaceSize >= this.minChunkSize! * 1024) break
				divisible.count--
			} while (divisible.count > 0)
			let chunk0 = divisible.chunk, chunk1 = chunk0.next!
			let position = divisible.chunk.currentPosition
			for (let i = 0; i < divisible.count; i++) {
				position += spaceSize
				new Thread(chunk0 = new Chunk(this, position, chunk0, chunk1))
			}
		}
	}

	pause() {
		void this.criticalSection.sync(() => {
			if (!DownloadState.canPause(this.state)) return
			this.setState('paused')
		})
	}

	private saveDownload() {
		assert(this.state === 'downloading')
		assert(this.totalSize === undefined || this.currentSize === this.totalSize)
		this.setState('saving')
		const chunks = [...this.getChunks()]
		void this.doSaveDownload(chunks)
	}

	private get snapshotName() { return `${this.id}-snapshot` }

	private async doSaveDownload(chunks: Chunk[]) {
		if (this.isSavingDownload) return
		this.isSavingDownload = true

		const blobUrl = new class {
			value?: string
			open(blob: Blob | File | IDBPromisedMutableFile) {
				this.close()
				this.value = URL.createObjectURL(blob)
			}
			close() {
				if (!this.value) return
				URL.revokeObjectURL(this.value)
				this.value = undefined
			}
		}

		const filename = (this.filename || '').replace(/[\\/]+/g, '_')
			.replace(/</g, '(').replace(/>/g, ')').replace(/"/g, "'")
			.replace(/[\x00-\x1f\x7f-\x9f:*?|]+/g, ' ')
			.replace(/^[\s\u180e.]+|[\s\u180e.]+$/g, '') || undefined

		try {
			for (const lastTrial of [false, true]) {
				const snapshot = await fileStorage.get(this.snapshotName)
				if (snapshot) {
					blobUrl.open(snapshot)
				} else {
					await this.file!.getBlob(v => blobUrl.open(v), this.totalSize)
				}
				const saveId = (snapshot || !await Settings.get(
					'skipFirstSavingAttempt')) ? await browser.downloads.download({
						url: blobUrl.value!, filename,
						saveAs: {
							systemDefault: undefined,
							downloadFolder: false,
							alwaysAsk: true,
						}[await Settings.get('saveFileTo')],
					}) : NaN
				try {
					if (!Number.isFinite(saveId)) {
						const error = new Error('Saving attempt is skipped')
						browserDownloadCrashErrors.add(error)
						throw error
					}
					await waitForBrowserDownload(saveId)
				} catch (error) {
					if (snapshot || lastTrial ||
						!browserDownloadCrashErrors.has(error)) throw error
					blobUrl.close()
					if (Number.isFinite(saveId))
						await removeBrowserDownload(saveId)
					await fileStorage.initialization /* prevent async */
					await this.file!.getBlob(blob =>
						fileStorage.set(this.snapshotName, blob))
					continue
				}
				this.fileAccessId = saveId
				this.complete()
				break
			}
		} catch (error) {
			this.fail(error && !(error instanceof LocalizedError) &&
				error.message.includes('Download canceled') ?
				new LocalizedError('browserDownloadErased') : error)
		} finally {
			blobUrl.close()
			this.isSavingDownload = false
		}
	}

	complete() {
		this.criticalSection.sync(() => {
			this.setState('completed')
			void this.cleanupFileStorage()
		})
	}

	async cleanupFileStorage() {
		if (this.file) void this.file.destroy()
		delete this.file
		void fileStorage.delete(this.snapshotName)
	}

	remove() {
		this.criticalSection.sync(() => {
			for (const thread of [...this.threads.values()]) thread.remove()
			Task.list.splice(Task.list.indexOf(this), 1)
			void this.cleanupFileStorage()
			void taskStorage.delete(this.id)
			if (this.fileAccessId !== undefined)
				void removeBrowserDownload(this.fileAccessId)
			broadcastRemote.notifyRemove(this.id)
			void updateBadge()
		})
	}

	write(thread: Thread, data: ArrayBuffer) {
		return this.criticalSection.sync(async () => {
			if (!thread.exists) return
			const { chunk } = thread
			let adjust = false, remove = false
			while (data.byteLength > chunk.remainingSize &&
				chunk.next!.next && !chunk.next!.currentSize) {
				const nextThread = chunk.next!.thread
				if (nextThread) { nextThread.remove(); adjust = true }
				chunk.next = chunk.next!.next
				chunk.next!.prev = chunk
			}
			const addedSize = Math.min(data.byteLength, chunk.remainingSize)
			if (addedSize === chunk.remainingSize) { remove = adjust = true }
			if (chunk.remainingSize > 0) {
				try {
					await this.file!.write(data, chunk.currentPosition)
				} catch (error) { return this.setFailure(error) }
				chunk.currentSize += addedSize
				this.currentSize += addedSize
			}
			if (remove) thread.remove()
			if (adjust) this.adjustThreads()
		})
	}

	finishThread(thread: Thread, error: Error | undefined) {
		// should be called by thread itself
		void this.criticalSection.sync(() => {
			if (!thread.exists) return
			// after locked, all the writes have completed.
			if (!error && this.totalSize !== undefined &&
				thread.chunk.remainingSize > 0) {
				// this happens after setDetail, in the thread's fetch
				assert(Number.isFinite(thread.chunk.totalSize))
				error = new LocalizedError('threadStopped')
			}
			thread.remove()
			if (error && error.name !== 'AbortError') {
				const localizedError = error instanceof LocalizedError ? error :
					(error.name === 'TypeError' &&
						error.message.startsWith('NetworkError')) ?
						new LocalizedError('networkError') :
						new LocalizedError('unknownError', [`${error}`])
				Log.warn('thread failed', thread.chunk.initPosition,
					thread.chunk.currentPosition, localizedError.message)
				if (!this.isRangeSupported || this.totalSize === undefined)
					return this.setFailure(localizedError)
				if (this.currentMaxRetries <= 0) {
					this.currentMaxThreads = Math.min(
						this.currentMaxThreads, this.threads.size)
					if (!this.currentMaxThreads)
						return this.setFailure(localizedError)
				} else --this.currentMaxRetries
			}
			this.adjustThreads()
		})
	}

	private setFailure(error: LocalizedError) {
		if (!DownloadState.isProgressing(this.state)) return
		Log.error('task failed', this.id, error.message)
		this.error = error.message
		this.setState('failed')
	}

	fail(error: LocalizedError) {
		void this.criticalSection.sync(async () => this.setFailure(error))
	}

	getAllUpdateData(): TaskUpdateData {
		return {
			state: this.state,
			url: this.url,
			referrer: this.referrer,
			error: this.error,
			filename: this.filename,
			totalSize: this.totalSize,
			currentSize: this.currentSize,
			threadCount: this.threads.size,
			averageSpeed: this.averageSpeed,
			chunks: [...this.getChunks()].reduce((v0, v1) =>
				Object.assign(v0, v1.updateData), {} as { [id: number]: number }),
			fileAccessId: this.fileAccessId,
			pauseIsStop: !this.isRangeSupported,
		}
	}

	get averageSpeed() {
		return this.startTime && (
			(this.currentSize - this.startSize) /
			((Date.now() - this.startTime.getTime()) / 1000))
	}
}

const writeChunksTimer = new Timer(async () => {
	const tasks = Task.list.filter(t => t.state === 'downloading')
	if (!tasks.length) {
		Log.log('writeChunksTimer.stop')
		writeChunksTimer.stop()
		return
	}
	await Promise.all(tasks.map(task => task.writeChunks().catch(() => { })))
}, 1000)

class Chunk {
	thread?: Thread
	currentSize = 0
	get currentPosition() { return this.initPosition + this.currentSize }
	get totalSize() {
		return this.next ? this.next.initPosition - this.initPosition : Infinity
	}
	get remainingSize() { return this.totalSize - this.currentSize }
	get updateData() { return { [this.initPosition]: this.currentSize } }

	constructor(readonly task: Task, readonly initPosition: number,
		public prev: Chunk | undefined, public next: Chunk | undefined) {
		assert(!prev && initPosition === 0
			|| prev && initPosition >= prev.currentPosition)
		assert(!next || next && initPosition <= next.initPosition)
		if (this.next) this.next.prev = this
		if (this.prev) this.prev.next = this
	}
}

const extensionHeader = 'x-multithreaded-download-manager-' +
	[...window.crypto.getRandomValues(new Uint8Array(12))].map(
		v => 'abcdefghijklmnopqrstuvwxyz'[v % 26]).join('')

interface ThreadInfo {
	taskId: number
	initPosition: number
	threadId: number
}

class Thread {
	static nextId = 0
	readonly id = Thread.nextId++

	private response?: Response
	readonly initPosition: number
	private readonly controller = new AbortController()
	preventAbort = false

	constructor(readonly chunk: Chunk) {
		this.initPosition = this.chunk.currentPosition
		assert(!this.task.threads.has(this.initPosition))
		assert(!chunk.thread)
		Log.log('thread created', this.initPosition)
		chunk.thread = this
		this.task.threads.set(this.initPosition, this)
		const minErrorDelayPromise = new Promise(resolve =>
			setTimeout(resolve, 1000))
		void this.init().catch(error =>
			minErrorDelayPromise.then(() => this.task.finishThread(this, error)))
	}

	get task() { return this.chunk.task }

	private async init() {
		const headers = new Headers(this.initPosition > 0 ? {
			Range: `bytes=${this.initPosition}-`,
		} : {})
		headers.append(extensionHeader, JSON.stringify({
			taskId: this.task.id,
			initPosition: this.initPosition,
			threadId: this.id,
		} as ThreadInfo))

		this.response = await fetch(this.task.url, {
			credentials: "include",
			signal: this.controller.signal,
			headers,
		})
		if (this.controller.signal.aborted) throw abortError()

		if (!this.response.ok) {
			throw new LocalizedError('unsuccessfulResponse',
				this.response.status, this.response.statusText)
		}

		if (!this.chunk.next) {
			let totalSize: number | undefined = Number(
				this.response.headers.get('content-length') || NaN)
			if (!Number.isInteger(totalSize)) {
				totalSize = undefined
				Log.warn(browser.i18n.getMessage(
					'rangesNotSupported', ['Content-Length']))
			}
			const acceptRanges = (this.response.headers.get('accept-ranges')
				|| '').toLowerCase() === 'bytes'
			if (!acceptRanges)
				Log.warn(browser.i18n.getMessage(
					'rangesNotSupported', ['Accept-Ranges']))

			await this.task.setDetail(this,
				await getSuggestedFilename(this.response.url,
					this.response.headers.get('content-disposition') || ''),
				totalSize, acceptRanges)
		}
		await this.response.arrayBuffer() // empty, only for catching error
		this.task.finishThread(this, undefined)
	}

	get exists() { return this.chunk.thread === this }

	remove() {
		if (!this.exists) return
		Log.log('thread removed', this.initPosition)
		this.chunk.thread = undefined
		this.task.threads.delete(this.initPosition)
		if (!this.preventAbort) this.controller.abort()
		broadcastRemote.update([[this.task.id, {
			chunks: this.chunk.updateData,
			currentSize: this.task.currentSize,
		}]])
	}
}

const downloadRequestMap = new Map<string, Thread>()
const downloadRequestFilter = {
	urls: ['<all_urls>'] as ['<all_urls>'],
	types: ['xmlhttprequest'] as ['xmlhttprequest'],
}
browser.webRequest.onBeforeSendHeaders.addListener(({ requestId, requestHeaders }) => {
	if (!requestHeaders!.some(h => h.name.toLowerCase() === extensionHeader)) return {}
	const headers = new Map(requestHeaders!.map(h =>
		[h.name.toLowerCase(), h.value] as [string, string]))

	let thread: Thread
	try {
		const infoStr = headers.get(extensionHeader) as string
		const info = JSON.parse(infoStr) as ThreadInfo
		const task = Task.get(info.taskId)
		thread = task!.threads.get(info.initPosition)!
		if (!thread || !thread.exists || thread.id != info.threadId) return {}
	} catch { return {} }
	downloadRequestMap.set(requestId, thread)

	const newHeaders = requestHeaders!.filter(v =>
		![extensionHeader, 'accept-encoding', 'origin', 'referer'].includes(
			v.name.toLowerCase()))
	if (thread.task.referrer)
		newHeaders.push({ name: 'Referer', value: thread.task.referrer })
	return { requestHeaders: newHeaders }
}, downloadRequestFilter, ['requestHeaders', 'blocking'])

browser.webRequest.onHeadersReceived.addListener(({ requestId, statusCode }) => {
	const thread = downloadRequestMap.get(requestId)
	if (!thread) return {}
	if (statusCode >= 200 && statusCode < 300) {
		downloadRequestMap.delete(requestId)
		thread.preventAbort = true
		const filter = browser.webRequest.filterResponseData(requestId)
		const buffers: ArrayBuffer[] = []
		let lastCommitTime = performance.now()

		const commit = () => {
			const data = new Uint8Array(buffers.reduce((s, v) => s + v.byteLength, 0))
			buffers.reduce((s, v) =>
				(data.set(new Uint8Array(v), s), s + v.byteLength), 0)
			void thread.task.write(thread, data.buffer as ArrayBuffer)
			buffers.length = 0
			lastCommitTime = performance.now()
		}

		const stop = () => { commit(); filter.close() }

		filter.onstart = () => { if (!thread.exists) filter.close() }
		filter.ondata = ({ data }) => {
			if (!thread.exists) { stop(); return; }
			buffers.push(data)
			if (performance.now() - lastCommitTime > 300) commit()
		}
		filter.onstop = stop; filter.onerror = stop
	}
	return {}
}, downloadRequestFilter, ['blocking'])

browser.webRequest.onErrorOccurred.addListener(({ requestId }) => {
	downloadRequestMap.delete(requestId)
}, downloadRequestFilter)
browser.webRequest.onResponseStarted.addListener(({ requestId }) => {
	downloadRequestMap.delete(requestId)
}, downloadRequestFilter)

function parseRFC5987(value: string) {
	try {
		const parts = value.split('\'')
		if (parts.length !== 3) return undefined
		if (['utf-8', 'utf8'].includes(parts[0].toLowerCase()))
			return decodeURIComponent(parts[2])
		const arr = (parts[2].match(/%[0-9a-fA-F]{2}|./g) || [])
			.map(v => v.length === 3 ? parseInt(v.slice(1), 16) : v.charCodeAt(0))
			.filter(v => v <= 255)
		return (new TextDecoder(parts[0])).decode(Uint8Array.from(arr))
	} catch { return undefined }
}

function parseLegacyFilename(value: string, legacyFilenameSettings: Settings) {
	if (legacyFilenameSettings.legacyFilenameDetectURLEncoded) try {
		const decoded = decodeURIComponent(value)
		if (decoded !== value) return decoded
	} catch { }
	if (legacyFilenameSettings.legacyFilenameDetectUTF8) try {
		return decodeURIComponent(escape(value))
	} catch { }
	try {
		const encoding = legacyFilenameSettings.legacyFilenameEncoding ||
			document.characterSet || 'UTF-8'
		const arr = [...value].map(v => v.charCodeAt(0)).filter(v => v <= 255)
		return (new TextDecoder(encoding)).decode(Uint8Array.from(arr))
	} catch { return undefined }
}

function getSuggestedFilename(url: string, contentDisposition: string):
	Promise<string>
function getSuggestedFilename(url: string, contentDisposition: string,
	legacyFilenameSettings: Settings): string
function getSuggestedFilename(url: string, contentDisposition: string,
	legacyFilenameSettings?: Settings) {
	if (!legacyFilenameSettings)
		return Settings.load([
			'legacyFilenameEncoding', 'legacyFilenameDetectUTF8',
			'legacyFilenameDetectURLEncoded',
		]).then(v => getSuggestedFilename(url, contentDisposition, v))
	const regex = /^\s*filename(\*?)\s*=\s*("[^"]+"?|[^\s;]+)(;?)/i
	let filename = ''
	for (let match: string[] | null,
		s = contentDisposition.replace(/^\s*[-\w]+\s*(?:;|$)/, '');
		match = regex.exec(s); s = s.replace(regex, '')) {
		if (!filename || match[1]) {
			let value = match[2].trim()
			if (value.startsWith('"')) {
				value = value.slice(1)
				if (value.endsWith('"')) value = value.slice(0, -1)
			}
			filename = (match[1] ? parseRFC5987(value) :
				parseLegacyFilename(value, legacyFilenameSettings)) || value
			if (match[1]) break // star
		}
		if (!match[3]) break // semicolon
	}
	return filename || getSuggestedFilenameFromURL(url)
}

if (!browser.contextMenus)
	browser.contextMenus = { create() { }, remove() { } } as any

const initialization = async function () {
	await Settings.set({ version: 0 })
	const persistent = (await browser.runtime.getPlatformInfo()).os !== 'android'
	taskStorage = new SimpleStorage({ databaseName: 'tasks', persistent })
	fileStorage = new SimpleStorage({
		persistent, databaseName: 'IDBFilesStorage-DB-taskFiles',
		storeName: 'IDBFilesObjectStorage',
	})
	const taskOrder = new Map((await Settings.get('taskOrder')).map(
		(v, i) => [v, i] as [number, number]))
	const getTaskOrder = (v: IDBValidKey) =>
		taskOrder.has(v as number) ? taskOrder.get(v as number)! : Infinity
	const taskIds = (await taskStorage.keys()).sort(
		(v0, v1) => getTaskOrder(v0) - getTaskOrder(v1)) as number[]
	const completedTasks: Task[] = []
	for (const id of taskIds) {
		const data = await taskStorage.get(id) as TaskPersistentData
		const task = new Task(data, id)
		if (data.state === 'completed') completedTasks.push(task)
	}
	if (await Settings.get('removeCompletedTasksOnStart'))
		for (const task of completedTasks)
			task.remove()

	void updateLinkContextMenu()

	browser.contextMenus.create({
		title: browser.i18n.getMessage('openInNewTab'),
		contexts: ['browser_action'],
		onclick: () => {
			browser.tabs.create({ url: browser.runtime.getURL('popup.html') })
		}
	})
	browser.contextMenus.create({
		title: browser.i18n.getMessage('openInNewWindow'),
		contexts: ['browser_action'],
		onclick: () => { openPopupWindow(browser.runtime.getURL('popup.html')) }
	})
}()

class BackgroundRemote {
	async createTask(options: TaskOptions) {
		await initialization
		return new Task(options).id
	}
	async getTaskOptions(id: number) {
		const task = Task.get(id)
		if (!task) return undefined
		const result = new TaskOptions({})
		for (const key of Object.keys(result) as (keyof TaskOptions)[])
			result[key] = task[key]
		return result
	}
	async setTaskOptions(id: number, options: TaskOptions) {
		Object.assign(Task.get(id) || {}, options)
	}
	async callTaskMethod(id: number, method: 'start' | 'pause' | 'remove') {
		const task = Task.get(id)
		if (task) task[method]()
	}
	async getFallbackEncoding() { return document.characterSet }
	async checkStorageAccess() {
		await initialization
		try { await taskStorage.get(-1) } catch { return false }
		return true
	}
	openPopupWindow(url: string) { return openPopupWindow(url) }
}
registerMessageRemoteHandler('remote-background', new BackgroundRemote())

const broadcastRemote = messageRemoteProxy('remote-broadcast') as BroadcastRemote

const updateTimer = new Timer(async () => {
	await initialization
	broadcastRemote.update(Task.list.map(task => [task.id, {
		chunks: [...task.threads.values()].reduce((v0, v1) =>
			Object.assign(v0, v1.chunk.updateData), {}),
		currentSize: task.currentSize,
		averageSpeed: task.averageSpeed,
	}] as [number, TaskUpdateData]))
}, 1000)

const portListeners = new Map<string, (port: browser.runtime.Port) => void>()
const subscriberPorts = new Set<browser.runtime.Port>()
browser.runtime.onConnect.addListener(async port => {
	if (port.name === 'subscribe') {
		port.onDisconnect.addListener(() => {
			subscriberPorts.delete(port)
			if (!subscriberPorts.size) updateTimer.stop()
		})
		subscriberPorts.add(port)
		if (!updateTimer.isStarted) updateTimer.start()
		await initialization
		broadcastRemote.update(Task.list.map(task =>
			[task.id, task.getAllUpdateData()] as [number, TaskUpdateData]))
		void updateBadge()
	} else {
		const listener = portListeners.get(port.name)
		if (!listener) return
		portListeners.delete(port.name)
		listener(port)
	}
})

async function updateBadge(state?: DownloadState) {
	const displayState = !subscriberPorts.size &&
		(state === 'completed' || state === 'failed') ? state : undefined
	const n = Task.list.filter(
		v => DownloadState.isProgressing(v.state)).length
	const type = await Settings.get('badgeType')
	if (type === 'none' || !(displayState || n) ||
		(displayState === 'completed' && !n && await Settings.get('hideBadgeZero'))) {
		await browser.browserAction.setBadgeText({ text: '' })
		return
	}
	await browser.browserAction.setBadgeText({ text: `${n}` })
	await browser.browserAction.setBadgeBackgroundColor(
		{ color: DownloadState.colors[displayState || 'downloading'] })
}
Settings.setListener('badgeType', () => void updateBadge())
Settings.setListener('hideBadgeZero', () => void updateBadge())

let linkContextMenuShown = false
async function updateLinkContextMenu() {
	const shown = !!await Settings.get('addContextMenuToLink')
	if (linkContextMenuShown === shown) return
	linkContextMenuShown = shown
	const id = 'link-context-menu'
	if (linkContextMenuShown) {
		browser.contextMenus.create({
			id,
			title: browser.i18n.getMessage('downloadWith',
				[browser.i18n.getMessage('extensionName')]),
			contexts: ['link'],
			onclick: (info, tab) => {
				try {
					const url = new URL(info.linkUrl || '')
					if (!isValidProtocol(url.protocol))
						throw new LocalizedError('unsupportedURL',
							info.linkUrl || '')
					new Task({ url: url.href, referrer: tab.url }).start()
				} catch (error) {
					browser.notifications.create(null, {
						type: 'basic',
						title: browser.i18n.getMessage('extensionName'),
						message: error.message
					})
				}
			},
		})
	} else void browser.contextMenus.remove(id)
}
Settings.setListener('addContextMenuToLink', updateLinkContextMenu)

const monitorDownloadParams = {
	listenerAdded: false,
	minSize: 0,
	builtinExcludeMap: {
		pdf: 1, ['x-xpinstall']: 1, ['x-shockwave-flash']: 1, json: 1, xml: 1
	} as { [s: string]: 1 | undefined },
	builtinInclude(type: string) {
		type = type.toLowerCase()
		if (!type.startsWith('application/')) return false
		type = type.slice('application/'.length)
		const plus = type.lastIndexOf('+')
		if (plus !== -1) type = type.slice(plus + 1)
		return !monitorDownloadParams.builtinExcludeMap[type]
	},
	include: undefined as RegExp | undefined,
	exclude: undefined as RegExp | undefined,
	settingsKeys: ['monitorDownload', 'monitorDownloadMinSize',
		'monitorDownloadInclude', 'monitorDownloadExclude'] as (keyof Settings)[]
}

function monitorDownloadListener(
	{ requestId, url, originUrl, responseHeaders, statusCode, tabId, type }: {
		requestId: string,
		url: string,
		originUrl: string,
		responseHeaders?: { name: string, value?: string }[],
		statusCode: number,
		tabId: number,
		type: browser.webRequest.ResourceType,
	}) {
	let contentDisposition = '', lengthPresent = false,
		contentTypeIncluded = false, acceptRanges = false
	if (!(statusCode >= 200 && statusCode < 300)) return {}
	for (const header of responseHeaders!) {
		const name = header.name.toLowerCase()
		if (name === 'content-disposition') {
			contentDisposition = header.value || 'attachment'
			if (!contentDisposition.trim().toLowerCase().startsWith('attachment'))
				return {}
		} else if (name === 'content-length') {
			lengthPresent = true
			if (!header.value ||
				Number(header.value) < monitorDownloadParams.minSize * 1024)
				return {}
		} else if (name === 'content-type') {
			let type = header.value || ''
			const semicolon = type.indexOf(';')
			if (semicolon !== -1) type = type.slice(0, semicolon)
			type = type.trim()
			contentTypeIncluded = !!(monitorDownloadParams.builtinInclude(type) ||
				monitorDownloadParams.include &&
				monitorDownloadParams.include.test(type)) &&
				!(monitorDownloadParams.exclude &&
					monitorDownloadParams.exclude.test(type))
		} else if (name === 'accept-ranges')
			acceptRanges = (header.value || '').toLowerCase() === 'bytes'
	}
	if (!lengthPresent || !acceptRanges ||
		!contentDisposition && !contentTypeIncluded) return {}
	const portName = `monitor/${encodeURIComponent(requestId)}`

	const resultPromise = new Promise<{ cancel?: boolean }>(resolve => {
		portListeners.set(portName, port => {
			port.onDisconnect.addListener(() => resolve({ cancel: true }))
			port.onMessage.addListener(
				({ name }: any) => { if (name === 'continue') resolve({}) })
			getSuggestedFilename(url, contentDisposition).then(filename =>
				port.postMessage({
					name: 'options', options: {
						url, filename, referrer: originUrl || ''
					} as TaskOptions
				}))
		})
		setTimeout(() => {
			if (portListeners.delete(portName)) resolve({})
		}, 15000)
	})
	resultPromise.then(async ({ cancel }) => {
		if (!cancel || type !== 'main_frame' || tabId === -1) return
		if (!await Settings.get('autoCloseBlankTab')) return
		const { url, windowId } = await browser.tabs.get(tabId)
		if (url !== 'about:blank') return
		if ((await browser.windows.get(windowId, { populate: true }))
			.tabs!.length <= 1) return
		await browser.tabs.remove(tabId)
	})
	openPopupWindow(browser.runtime.getURL(`edit.html#/${portName}`))
	return resultPromise
}

async function updateMonitorDownload() {
	const settings = await Settings.load(monitorDownloadParams.settingsKeys)
	if (!!settings.monitorDownload !== monitorDownloadParams.listenerAdded) {
		monitorDownloadParams.listenerAdded = !!settings.monitorDownload
		if (monitorDownloadParams.listenerAdded)
			browser.webRequest.onHeadersReceived.addListener(
				monitorDownloadListener,
				{ urls: ['<all_urls>'], types: ['main_frame', 'sub_frame'] },
				['blocking', 'responseHeaders'])
		else
			browser.webRequest.onHeadersReceived.removeListener(
				monitorDownloadListener)
	}
	monitorDownloadParams.minSize = settings.monitorDownloadMinSize
	monitorDownloadParams.include = settings.monitorDownloadInclude ?
		new RegExp(settings.monitorDownloadInclude, 'i') : undefined
	monitorDownloadParams.exclude = settings.monitorDownloadExclude ?
		new RegExp(settings.monitorDownloadExclude, 'i') : undefined
}
updateMonitorDownload()
for (const key of monitorDownloadParams.settingsKeys)
	Settings.setListener(key, updateMonitorDownload)

async function updateNewTaskAtTop() {
	await initialization
	Task.newTaskAtTop = !!await Settings.get('newTaskAtTop')
}
updateNewTaskAtTop()
Settings.setListener('newTaskAtTop', updateNewTaskAtTop)

browser.runtime.onUpdateAvailable.addListener(() => { })

async function updateIconColor() {
	const iconColor = await Settings.get('iconColor')
	if (iconColor !== 'default')
		await browser.browserAction.setIcon(
			{ path: `icons/icon-color.svg#${iconColor}` })
}
updateIconColor()
Settings.setListener('iconColor', updateIconColor)