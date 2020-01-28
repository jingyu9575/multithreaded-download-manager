import '../util/polyfills.js';
import { SimpleStorage, SimpleMutableFile } from "../util/storage.js";
import { typedArrayToBuffer, concatTypedArray } from "../util/util.js";
import { CriticalSection } from "../util/promise.js";
import { assert, unreachable } from "../util/error.js";
import { isWebExtOOPDisabled } from "./webext-oop.js";
import { S } from "./settings.js";
import { SimpleEventListener } from '../util/event.js';

type TypeOfChunkStorage = typeof ChunkStorage
export interface ChunkStorageClass extends TypeOfChunkStorage { }

export abstract class ChunkStorage {
	static readonly isAvailable: boolean

	static get implementations() {
		return {
			MutableFile: MutableFileChunkStorage,
			SegmentedFile: SegmentedFileChunkStorage,
		}
	}

	constructor(readonly id: number) { }
	abstract init(isLoaded: boolean): Promise<void>
	abstract load(totalSize: number): Promise<ChunkStorageWriter[]>
	abstract writer(startPosition: number): ChunkStorageWriter
	abstract persist(totalSize: number | undefined, final: boolean): Promise<void>
	abstract getFile(): Promise<File> // must call persist(totalSize, true) first
	abstract reset(): void // all writers are invalidated
	abstract delete(): void | Promise<void> // other methods can still be called
	abstract readSlices(totalSize: number): AsyncIterable<ArrayBuffer>
	readonly onError = new SimpleEventListener<[Error]>()
	abstract readonly flushInterval: number // seconds
}

export class ChunkStorageWriter {
	private promise = Promise.resolve()

	constructor(
		protected readonly parent: ChunkStorage | undefined,
		readonly startPosition: number,
		public writtenSize = 0,
	) { }

	private sync(fn: () => Promise<void>) {
		const result = this.promise.then(fn)
		this.promise = result.catch(error => {
			this.promise = this.promise.then(() => { }, () => { })
			if (this.parent) this.parent.onError.dispatch(error)
		})
		return result
	}

	// CANNOT reorder
	write(data: Uint8Array) { return this.sync(() => this.doWrite(data)) }
	flush() { return this.sync(() => this.doFlush()) }

	// NOT thread safe
	protected async doWrite(_data: Uint8Array) { unreachable() }
	protected async doFlush() { }
}

export class MutableFileChunkStorage extends ChunkStorage {
	static readonly isAvailable = 'IDBMutableFile' in window

	private static storage = SimpleStorage.create("files")
	// Firefox 74 has removed IDBMutableFile.getFile (Bug 1607791)
	private static tempStorage = SimpleStorage.create(`files-temp-storage`)

	readonly flushInterval = Infinity
	private get mfileName() { return `${this.id}` }// backward compatibility
	file!: SimpleMutableFile

	private readonly persistCriticalSection = new CriticalSection()
	private persistSentry = {}

	// Written at totalSize for shared files
	// [ persistenceData.length - 1, (startPosition, currentSize)...  ]
	persistenceData = new Float64Array([0])

	async init(isLoaded: boolean) {
		const storage = await MutableFileChunkStorage.storage
		let mutableFile = isLoaded ?
			(await storage.get(this.mfileName) as IDBMutableFile) : undefined
		if (!mutableFile) {
			mutableFile = await storage.mutableFile(`chunk-storage-${this.id}`)
			await storage.set(this.mfileName, mutableFile)
		}
		this.file = new SimpleMutableFile(mutableFile)
	}

	async load(totalSize: number) {
		try {
			const BYTES = Float64Array.BYTES_PER_ELEMENT
			const size = new Float64Array(await this.file.read(BYTES, totalSize))[0]
			if (!size /* 0 | undefined */) return []
			const data = new Float64Array(
				await this.file.read(BYTES * (size + 1), totalSize))
			if (data.length !== size + 1) return []
			assert(this.persistenceData.length === 1) // cannot be called after writer
			this.persistenceData = data
		} catch (error) {
			console.warn('MutableFileChunkStorage.load', this.mfileName, error)
		}

		const result: ChunkStorageWriter[] = []
		for (let i = 1; i < this.persistenceData.length; i += 2)
			result.push(new MutableFileChunkStorage.Writer(this, i))
		return result
	}

	writer(startPosition: number) {
		const persistenceIndex = this.persistenceData.length
		this.persistenceData = concatTypedArray([
			this.persistenceData, new Float64Array([startPosition, 0])
		])!
		this.persistenceData[0] += 2
		return new MutableFileChunkStorage.Writer(this, persistenceIndex)
	}

	persist(totalSize: number | undefined, final: boolean) {
		if (totalSize === undefined) return Promise.resolve()
		const sentry = this.persistSentry
		return this.persistCriticalSection.sync(async () => {
			if (sentry !== this.persistSentry) return
			if (final)
				await this.file.truncate(totalSize)
			else
				await this.file.write(typedArrayToBuffer(
					this.persistenceData) as ArrayBuffer, totalSize)
		})
	}

	// Workaround for disabling webext-oop
	private get snapshotName() { return `${this.mfileName}-snapshot` }

	async getFile() {
		if (this.file.requiresTempStorage) {
			return this.file.getFileWithTempStorage(
				await MutableFileChunkStorage.tempStorage, this.mfileName)
		}
		if (isWebExtOOPDisabled) {
			const storage = await MutableFileChunkStorage.storage
			storage.set(this.snapshotName, await this.file.getFile())
			return storage.get<File>(this.snapshotName)
		}
		return this.file.getFile()
	}

	reset() {
		this.persistenceData = new Float64Array([0])
		this.persistSentry = {}
		void this.file.truncate(0)
	}

	async delete() {
		const storage = await MutableFileChunkStorage.storage
		void storage.delete(this.mfileName)
		void storage.delete(this.snapshotName)
		const tempStorage = await MutableFileChunkStorage.tempStorage
		SimpleMutableFile.cleanupTempStorage(tempStorage, this.mfileName)
		// other methods can still access the unlinked file
	}

	async* readSlices(totalSize: number) {
		const SLICE_SIZE = 1024 * 1024 * 16
		for (let position = 0; position < totalSize; position += SLICE_SIZE)
			yield await this.file.read(SLICE_SIZE, position)
	}
}

export namespace MutableFileChunkStorage {
	export class Writer extends ChunkStorageWriter {
		constructor(
			protected readonly parent: MutableFileChunkStorage,
			persistenceIndex: number,
		) {
			super(parent, parent.persistenceData[persistenceIndex],
				parent.persistenceData[persistenceIndex + 1])
			this.writtenSizeIndex = persistenceIndex + 1
		}

		private readonly writtenSizeIndex: number

		protected async doWrite(data: Uint8Array) {
			if (!data.length) return
			const { persistenceData } = this.parent
			await this.parent.file.write(typedArrayToBuffer(data) as ArrayBuffer,
				this.startPosition + this.writtenSize)
			this.writtenSize += data.length
			persistenceData[this.writtenSizeIndex] = this.writtenSize
		}
	}
}

export class SegmentedFileChunkStorage extends ChunkStorage {
	static readonly isAvailable = true

	private static storagePromise = SimpleStorage.create("segments")
	storage!: SimpleStorage

	currentFileCount = 0
	flushInterval = S.segmentsIntervalInit
	nextUpdateFileCount = S.segmentsIntervalGrowPerFiles

	flushSentry = {}

	private get keyRange() { return IDBKeyRange.bound([this.id], [this.id, []]) }
	private getEntries() { return this.storage.entries(this.keyRange, 'readonly') }

	updateFlushInterval() {
		this.flushInterval = Math.min(S.segmentsIntervalMax,
			S.segmentsIntervalInit * S.segmentsIntervalGrowFactor **
			Math.floor(this.currentFileCount / S.segmentsIntervalGrowPerFiles))
		this.nextUpdateFileCount = this.currentFileCount
			- (this.currentFileCount % S.segmentsIntervalGrowPerFiles)
			+ S.segmentsIntervalGrowPerFiles
	}

	async init(isLoaded: boolean) {
		this.storage = await SegmentedFileChunkStorage.storagePromise
		if (!isLoaded) await this.reset()
	}

	async load() {
		const result: ChunkStorageWriter[] = []
		let startPosition = 0
		let bufferPosition = 0
		this.currentFileCount = 0
		for await (const cursor of this.getEntries()) {
			const [, position] = cursor.primaryKey as [number, number]
			if (position !== bufferPosition) {
				assert(position > bufferPosition)
				result.push(new SegmentedFileChunkStorage.Writer(
					this, startPosition, bufferPosition - startPosition))
				startPosition = bufferPosition = position
			}
			bufferPosition += (cursor.value as Blob).size // assert(size > 0)
			this.currentFileCount++
		}
		if (bufferPosition > startPosition) // <=> bufferPosition > 0
			result.push(new SegmentedFileChunkStorage.Writer(
				this, startPosition, bufferPosition - startPosition))
		this.updateFlushInterval()
		return result
	}

	writer(startPosition: number): ChunkStorageWriter {
		return new SegmentedFileChunkStorage.Writer(this, startPosition)
	}

	async persist() { /* do nothing */ }

	async getFile(): Promise<File> {
		const blobs: Blob[] = []
		let bufferPosition = 0

		for await (const cursor of this.getEntries()) {
			const [, position] = cursor.primaryKey as [number, number]
			assert(position === bufferPosition)
			blobs.push(cursor.value)
			bufferPosition += (cursor.value as Blob).size
		}
		return new File(blobs, "file")
	}

	reset() {
		this.flushSentry = {}
		this.currentFileCount = 0
		this.updateFlushInterval()
		return this.storage.delete(this.keyRange)
	}

	delete() { return this.reset() }

	async* readSlices() {
		const blobs: Blob[] = []
		for await (const cursor of this.getEntries())
			blobs.push(cursor.value as Blob)
		for (const blob of blobs) yield await blob.arrayBuffer()
	}
}

export namespace SegmentedFileChunkStorage {
	export class Writer extends ChunkStorageWriter {
		protected readonly parent!: SegmentedFileChunkStorage
		private bufferData: Uint8Array[] = []
		private bufferPosition = this.startPosition + this.writtenSize
		private readonly flushSentry = this.parent.flushSentry

		protected async doWrite(data: Uint8Array) {
			if (!data.length) return
			this.bufferData.push(data)
			this.writtenSize += data.length
		}

		protected async doFlush() {
			if (this.flushSentry !== this.parent.flushSentry) return
			if (!this.bufferData.length) return
			const data = concatTypedArray(this.bufferData)!
			assert(data.length > 0)
			await this.parent.storage.set(
				[this.parent.id, this.bufferPosition], new Blob([data]))
			this.bufferPosition += data.length
			this.bufferData = []
			this.parent.currentFileCount++
			if (this.parent.currentFileCount >= this.parent.nextUpdateFileCount)
				this.parent.updateFlushInterval()
		}
	}
}
