import { SimpleStorage, SimpleMutableFile } from "../util/storage.js";
import { typedArrayToBuffer, concatTypedArray } from "../util/util.js";
import { CriticalSection } from "../util/promise.js";
import { assert, unreachable } from "../util/error.js";
import { isWebExtOOPDisabled } from "./webext-oop.js";

export interface ChunkStorage {
	load(totalSize: number): Promise<ChunkStorage.Writer[]>
	writer(startPosition: number): ChunkStorage.Writer
	persist(totalSize: number | undefined, final: boolean): Promise<void>
	getFile(): Promise<File> // must call persist(totalSize, true) first
	reset(): void // truncate file; clear persistenceData; all writers are invalidated
	delete(): void // other methods can still be called
	read(position: number, size: number): Promise<ArrayBuffer>
}

export namespace ChunkStorage {
	export interface Class {
		create(id: IDBValidKey, isLoaded: boolean): Promise<ChunkStorage>
	}

	export interface Writer {
		readonly startPosition: number
		readonly writtenSize: number
		write(data: Uint8Array): Promise<void> // NOT thread safe
	}

	export class DummyWriter implements Writer {
		constructor(
			readonly startPosition: number,
			readonly writtenSize = 0,
		) { }
		write(): never { unreachable() }
	}
}

export class MutableFileChunkStorage implements ChunkStorage {
	private static storage = SimpleStorage.create("files")
	// Firefox 74 has removed IDBMutableFile.getFile (Bug 1607791)
	private static tempStorage = SimpleStorage.create(`files-temp-storage`)

	private constructor(
		private readonly mfileName: string,
		private readonly file: SimpleMutableFile,
	) { }

	private readonly persistCriticalSection = new CriticalSection()
	private persistSentry = {}

	// Written at totalSize for shared files
	// [ persistenceData.length - 1, (startPosition, currentSize)...  ]
	private persistenceData = new Float64Array([0])

	static async create(id: number, isLoaded: boolean) {
		const mfileName = `${id}` // backward compatibility
		const storage = await this.storage
		let mutableFile = isLoaded ?
			(await storage.get(mfileName) as IDBMutableFile) : undefined
		if (!mutableFile) {
			mutableFile = await storage.mutableFile(`chunk-storage-${mfileName}`)
			await storage.set(mfileName, mutableFile)
		}
		return new this(mfileName, new SimpleMutableFile(mutableFile))
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

		const result: ChunkStorage.Writer[] = []
		for (let i = 1; i < this.persistenceData.length; i += 2)
			result.push(new MutableFileChunkStorage.Writer(this, i))
		return result
	}

	static Writer = class implements ChunkStorage.Writer {
		constructor(
			private readonly parent: MutableFileChunkStorage,
			persistenceIndex: number,
		) {
			this.startPosition = this.parent.persistenceData[persistenceIndex]
			this.writtenSizeIndex = persistenceIndex + 1
			this.writtenSize = this.parent.persistenceData[this.writtenSizeIndex]
		}

		readonly startPosition: number
		private readonly writtenSizeIndex: number
		writtenSize: number

		async write(data: Uint8Array) {
			if (!data.length) return
			await this.parent.file.write(typedArrayToBuffer(data) as ArrayBuffer,
				this.startPosition + this.writtenSize)
			this.writtenSize += data.length
			this.parent.persistenceData[this.writtenSizeIndex] = this.writtenSize
		}
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

	read(position: number, size: number) { return this.file.read(size, position) }
}
