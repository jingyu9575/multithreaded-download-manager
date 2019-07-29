import { DownloadState, MultithreadedTaskData, TaskProgressItems } from "../common/task-data.js";
import {
	ChunkStorage, ChunkStorageClass, ChunkStorageWriter, MutableFileChunkStorage
} from "./chunk-storage.js";
import {
	Connection, ConnectionClass, StreamsConnection, StreamFilterConnection
} from "./connection.js";
import { Task } from "./task.js";
import { assert, unreachable, ReportedError, isAbortError, abortError } from "../util/error.js";
import { setImmediate } from "../util/set-immediate.js"
import { Timer, CriticalSection } from "../util/promise.js";
import { browserDownloadResult } from "./browser-download.js";
import { removeBrowserDownload } from "../common/common.js";
import { M } from "../util/webext/i18n.js";
import { resolveFilenameTemplate } from "./filename-template.js";
import { NETWORK_OPTIONS_KEYS } from "../common/settings.js";
import { S } from "./settings.js";
import { SiteHandlerInvoker } from "./site-handler.js";
import { Sha1 } from "../lib/asmcrypto.js/hash/sha1/sha1.js";
import { Sha256 } from "../lib/asmcrypto.js/hash/sha256/sha256.js";

export class MultithreadedTask extends Task<MultithreadedTaskData> {
	private readonly chunkStorageClass: ChunkStorageClass = MutableFileChunkStorage
	private readonly connectionClass: ConnectionClass = (() => {
		const result = MultithreadedTask.getPreferredConnectionClass()
		return result.isAvailable ? result : StreamFilterConnection
	})()

	static getPreferredConnectionClass() {
		return {
			'': StreamsConnection,
			Streams: StreamsConnection,
			StreamFilter: StreamFilterConnection,
		}[S.connectionAPI]
	}

	// assert(firstChunk && lastChunk || !firstChunk && !lastChunk)
	// The first Chunk starting at 0 with the initial connection
	private firstChunk?: Chunk
	// Marks the end of the file, or Infinity if the size is unknown
	// Has no size or connection.
	private lastChunk?: Chunk

	private initialConnection?: Connection
	private readonly connections = new Map<Connection, Chunk>()
	private currentMaxThreads = 1
	private currentWarnings = 0
	private chunkStorage?: ChunkStorage

	private currentSize = 0
	private startTime?: number
	private startSize = 0

	private readonly siteHandlerInvoker = new SiteHandlerInvoker()
	private checksumSentry = {}

	get averageSpeed() {
		return this.startTime === undefined ? undefined :
			(this.currentSize - this.startSize) /
			((performance.now() - this.startTime) / 1000)
	}

	private readonly updatedChunks = new Set<Chunk>()

	private readonly timer = new Timer(async () => {
		if (this.data.state !== 'downloading') return
		const connections = [...this.connections.keys()]
		for (const connection of connections)
			connection.prepare()

		// delay of prepare() is estimated to be 2 * setImmediate
		await new Promise(setImmediate)
		await new Promise(setImmediate)

		if (this.data.state !== 'downloading') return
		const now = performance.now()
		const promises = connections.map(c => void this.pipeConnectionToChunk(c, now))
		if (!this.updatedChunks.size) return

		const chunks = [...this.updatedChunks]
		this.updatedChunks.clear()
		const firstChunkSentry = this.firstChunk
		setTimeout(() => {
			if (firstChunkSentry !== this.firstChunk) return
			this.syncProgress(this.getProgress(chunks))
		}, 200)

		await Promise.all(promises)

		this.persistChunks()
	}, 1000)

	private static remainingSimultaneousTasks() {
		let n = S.simultaneousTasks
		if (n === '') return Infinity
		for (const task of Task.list)
			if (task.data.type === this.name && task.data.state === 'downloading')
				n--
		return n
	}

	private static readonly startQueuedTasksTimer = new Timer(() => {
		const n = MultithreadedTask.remainingSimultaneousTasks()
		if (n <= 0) return
		Task.list.filter(v => v.data.type === MultithreadedTask.name &&
			v.data.state === 'queued').sort((v0, v1) => v0.id - v1.id)
			.slice(0, n).forEach(v => v.start())
	}, 0)

	static readonly initialization = Task.initialization.then(() => {
		MultithreadedTask.startQueuedTasksTimer.startOnce()
	})

	async init(isLoaded: boolean) {
		this.logger.i(M(isLoaded ? 'i_load' : 'i_create', this.id), this.data)

		for (const key of NETWORK_OPTIONS_KEYS)
			if (this.data[key] === undefined)
				Object.assign(this.data, { [key]: S[key] })

		if (this.data.state !== 'completed')
			this.chunkStorage = await this.chunkStorageClass.create(this.id, isLoaded)

		if (isLoaded && this.data.totalSize !== undefined) {
			if (DownloadState.areChunksFinished(this.data.state)) {
				this.firstChunk = new Chunk(undefined, 0, unreachable)
				this.lastChunk = new Chunk(this.firstChunk,
					this.data.totalSize, unreachable)
				this.firstChunk.initCurrentSize(this.data.totalSize)
				this.currentSize = this.data.totalSize
			} else if (this.data.canResume) {
				let chunk: Chunk | undefined = undefined
				this.currentSize = 0
				for (const v of (await this.chunkStorage!.load(this.data.totalSize))
					.sort((v0, v1) => v0.startPosition - v1.startPosition)) {
					chunk = new Chunk(chunk, v.startPosition, v.writer)
					if (!this.firstChunk) this.firstChunk = chunk
					chunk.initCurrentSize(v.currentSize)
					this.currentSize += chunk.currentSize
				}
				if (chunk) this.lastChunk = new Chunk(
					chunk, this.data.totalSize, unreachable)
			}
		}
		if (DownloadState.isProgressing(this.data.state) &&
			this.data.state !== 'queued') {
			Object.assign(this.data, { state: 'paused' })
			this.start()
		}

		if (!isLoaded) this.update({}) // persist
	}

	private * getChunks() {
		// [firstChunk, lastChunk)
		// [] if !firstChunk && !lastChunk
		for (let chunk = this.firstChunk;
			chunk !== this.lastChunk; chunk = chunk!.next)
			yield chunk!
	}

	async start() {
		if (!DownloadState.canStart(this.data.state)) return
		if (MultithreadedTask.remainingSimultaneousTasks() <= 0) {
			this.logger.i(M.i_queue)
			if (this.data.state !== 'queued')
				this.update({ state: 'queued' })
			return
		}

		this.logger.i(M('i_start', this.data.url))
		this.logger.i(M('i_api', this.connectionClass.name))
		this.currentMaxThreads = this.data.maxThreads!
		this.currentWarnings = 0
		this.startTime = performance.now()
		this.startSize = this.currentSize
		this.update({ state: 'downloading', error: null })

		if (!this.firstChunk) {
			const siteHanderResult = this.siteHandlerInvoker.invoke(this.data.url)
			const conn = this.initialConnection = this.createConnection(0, true)

			let connectionTimer: number | undefined
			if (S.connectionTimeout !== '') {
				connectionTimer = setTimeout(() => {
					if (conn.lastTransferTime !== undefined) return
					conn.abortWithError(new ReportedError(M.e_timeout,
						performance.now() - conn.startTime))
				}, S.connectionTimeout * 1000)
			} // initialConnection is not checked in pipeConnectionToChunk

			const info = (await conn.info)! // not undefined if !conn.error
			if (connectionTimer !== undefined) clearTimeout(connectionTimer)
			if (info && siteHanderResult)
				Object.assign(info, await siteHanderResult)

			if (conn.error) {
				if (!isAbortError(conn.error))
					this.fail(conn.error)
				else
					this.logger.i(M.i_initialConnectionAborted)
				return
			}
			this.logger.i(M('i_initialConnectionInfo', info.totalSize || '?',
				info.acceptRanges ? M.yes : M.no), info)

			// Check if the task is aborted
			if (this.initialConnection !== conn) return

			this.firstChunk = new Chunk(undefined, 0, this.chunkStorage!.writer(0))
			const { totalSize } = info
			this.lastChunk = new Chunk(this.firstChunk,
				totalSize !== undefined ? totalSize : Infinity, unreachable)

			const newData: Partial<MultithreadedTaskData> = {
				totalSize, url: info.finalURL,
				canResume: info.acceptRanges && totalSize !== undefined,
			}
			if (info.substituteFilename)
				newData.substituteFilename = info.substituteFilename
			if (info.substituteFilename || info.finalURL !== this.data.url)
				newData.filename = resolveFilenameTemplate(
					{ ...this.data, ...newData })
			this.update(newData)

			this.setChunkConnection(this.firstChunk, conn)
			this.initialConnection = undefined

			// spawn preallocation, to prevent invalid state
			// (discontinuous file without persistenceData)
			this.persistChunks()
		}

		this.adjustThreads()
		this.timer.start()
	}

	private persistChunks() {
		if (DownloadState.areChunksFinished(this.data.state)) return
		if (!this.data.canResume) return
		void this.chunkStorage!.persist(this.data.totalSize, false)
			.catch(error => this.fail(error))
	}

	private createConnection(position: number, isInitial: boolean) {
		this.logger.i(M('i_createConnection', position))
		const headers: Record<string, string> =
			position > 0 ? { Range: `bytes=${position}-`, } : {}
		let { url } = this.data
		try {
			const o = new URL(url)
			if (o.username || o.password) { // fetch does not support basic auth in URL
				headers['Authorization'] = 'Basic ' + btoa(unescape(encodeURIComponent(
					o.username + ":" + o.password)))
				o.username = o.password = ''
				url = o.href
			}
		} catch { }
		const connection = new this.connectionClass(
			new Request(url, {
				credentials: 'include',
				headers,
				referrer: this.data.referrer,
				cache: S.cacheMode || 'no-store',
			}), () => { this.onConnectionComplete(connection) }, {
				expectRangeWithSize: this.data.canResume &&
					this.data.totalSize !== undefined ?
					this.data.totalSize - position : undefined,
				requestSubstituteFilename: isInitial,
			})
		return connection
	}

	private setChunkConnection(chunk: Chunk, connection = this.createConnection(
		chunk.startPosition + chunk.currentSize, false)) {
		this.connections.set(connection, chunk)
	}

	private async pipeConnectionToChunk(connection: Connection, checkNow?: number) {
		const chunk = this.connections.get(connection)
		if (!chunk) return true

		const receivedData = connection.read()
		if (!receivedData) return true // return true if there is no more data
		if (!receivedData.byteLength) { // length = 0: check timeout and return false
			if (checkNow === undefined) return false
			const connected = connection.lastTransferTime !== undefined
			const timeout = connected ? S.transferTimeout : S.connectionTimeout
			if (timeout === '') return false
			const elapsedTime = checkNow - (connected ?
				connection.lastTransferTime! : connection.startTime)
			if (elapsedTime > timeout * 1000)
				connection.abortWithError(new ReportedError(M.e_timeout, elapsedTime))
			return false
		}

		if (checkNow !== undefined) connection.lastTransferTime = checkNow

		let writtenData = receivedData
		if (receivedData.byteLength > chunk.remainingSize) {
			writtenData = receivedData.slice(0, chunk.remainingSize)
			connection.abort()
		}
		chunk.currentSize += writtenData.byteLength
		this.currentSize += writtenData.byteLength
		const writeSentry = chunk.writeSentry
		this.updatedChunks.add(chunk)
		await chunk.writeCriticalSection.sync(async () => {
			try {
				if (writeSentry !== chunk.writeSentry) return
				await chunk.write(writtenData, chunk.startPosition + chunk.writtenSize)
				if (writeSentry !== chunk.writeSentry) return
				chunk.writtenSize += writtenData.byteLength
			} catch (error) {
				// invalidate all pending writes
				chunk.writeSentry = {}
				this.currentSize += chunk.writtenSize - chunk.currentSize
				chunk.currentSize = chunk.writtenSize
				this.fail(error)
			}
		})
		return false
	}

	protected getProgress(chunks = [...this.getChunks()]) {
		const items: TaskProgressItems = {}
		for (const { startPosition, currentSize, writtenSize } of chunks)
			items[startPosition] = { currentSize, writtenSize }
		const { currentSize, averageSpeed, currentWarnings } = this
		const currentThreads = this.connections.size
		return { items, currentSize, averageSpeed, currentWarnings, currentThreads }
	}

	private async onConnectionComplete(connection: Connection) {
		await connection.info // make sure reader is ready and inserted
		let { error } = connection
		if (error && connection !== this.initialConnection &&
			!isAbortError(error) && !Connection.isFatal(error)) {
			const MIN_ERROR_DELAY = 1000
			const time = performance.now() - connection.startTime
			if (time < MIN_ERROR_DELAY)
				await new Promise(r => setTimeout(r, MIN_ERROR_DELAY - time))
		}

		this.logger.i(M.i_connectionEnded, error)
		if (!this.connections.get(connection)) return
		if (!error) do {
			// wait for stop event if prepare() returns void
			await (connection.prepare() || new Promise(setImmediate))
		} while (!await this.pipeConnectionToChunk(connection))
		this.persistChunks()

		const chunk = this.connections.get(connection)
		if (!chunk) return
		if (!error && chunk.remainingSize > 0 && chunk.totalSize < Infinity)
			error = new ReportedError(M.e_threadStopped)
		this.syncProgress(this.getProgress([chunk]))

		this.connections.delete(connection) // already aborted

		if (error && !isAbortError(error)) {
			if (!this.data.canResume || Connection.isFatal(error))
				return this.fail(error)
			if (this.data.maxRetries !== '' &&
				this.currentWarnings >= this.data.maxRetries!)
				return this.fail(error)
			++this.currentWarnings

			const e = ReportedError.convert(error, M.e_unknownError)
			this.logger.w(e.fullMessage, e.detail)
		}

		this.adjustThreads()
	}

	private adjustThreads() {
		assert(this.data.state == 'downloading' && this.firstChunk && this.lastChunk)
		if (this.currentMaxThreads > this.connections.size)
			this.addThreads()
		if (!this.connections.size) void this.saveFile()
	}

	private addThreads() {
		if (!this.data.canResume) return
		let quota = this.currentMaxThreads - this.connections.size
		if (quota <= 0) return

		// first fill all the gaps
		const gaps = [] as { size: number, chunk: Chunk }[]
		const progressingChunks = new Set(this.connections.values())
		for (const chunk of this.getChunks())
			if (!progressingChunks.has(chunk) && chunk.remainingSize)
				gaps.push({ size: chunk.remainingSize, chunk })
		for (let i = 0; i < gaps.length && quota; i++)
			this.setChunkConnection(gaps[i].chunk), quota--
		if (quota <= 0) return

		// then divide existing chunks
		const divisibles = [...this.connections.values()].map(chunk =>
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
				if (spaceSize > 0 && spaceSize >= this.data.minChunkSize! * 1024) break
				divisible.count--
			} while (divisible.count > 0)
			let { chunk } = divisible
			let position = chunk.currentPosition
			for (let i = 0; i < divisible.count; i++) {
				position += spaceSize
				chunk = new Chunk(chunk, position, this.chunkStorage!.writer(position))
				this.setChunkConnection(chunk)
			}
		}
	}

	async syncProgressAfterWrites(reset = false) {
		await Promise.all([...this.getChunks()].map(
			c => c.writeCriticalSection.sync(() => { })))
		this.syncProgress({ reset, ...this.getProgress() })
	}

	async saveFile() {
		this.startTime = undefined
		await this.syncProgressAfterWrites()

		if (this.data.state !== 'downloading') return
		this.logger.i(M.i_save)
		this.update({ state: 'saving' })
		MultithreadedTask.startQueuedTasksTimer.startOnce()

		// prepare to get file
		await this.chunkStorage!.persist(this.data.totalSize, true)

		const saveAs = {
			systemDefault: undefined, downloadFolder: false, alwaysAsk: true,
		}[S.saveFileTo]

		try {
			await this.verifyChecksum()
			const blobURL = URL.createObjectURL(await this.chunkStorage!.getFile())
			let downloadId: number
			try {
				try {
					downloadId = (await browser.downloads.download(
						{ url: blobURL, filename: this.data.filename, saveAs }))!
				} catch (error) {
					throw !error.message.match(/\bDownload canceled\b/) ? error :
						new ReportedError(M.e_saveFileError, error.message)
				}
				await browserDownloadResult(downloadId)
			} finally {
				if (blobURL) URL.revokeObjectURL(blobURL)
			}
			this.logger.i(M.i_completed, downloadId)
			this.update({
				fileAccessId: downloadId, state: 'completed',
				completedDate: new Date(),
			})
			this.chunkStorage!.delete()
		} catch (error) {
			if (!isAbortError(error)) this.fail(error)
			this.persistChunks()
		}
	}

	private async verifyChecksum() {
		const { checksum } = this.data
		if (!checksum) return

		const hash = new (checksum.length === 64 ? Sha256 : Sha1)
		const SLICE_SIZE = 1024 * 1024 * 16
		const sentry = this.checksumSentry = {}
		for (let p = 0; p < this.currentSize; p += SLICE_SIZE) {
			if (this.checksumSentry !== sentry) throw abortError()
			hash.process(new Uint8Array(
				await this.chunkStorage!.read(p, SLICE_SIZE)))
		}
		hash.finish()

		const result = [...hash.result!].map(
			v => v.toString(16).padStart(2, '0')).join('')
		this.logger.i(M('i_checksum', result, checksum))
		if (result.toLowerCase() !== checksum.toLowerCase())
			throw new ReportedError(M.e_checksumError)
	}

	private removeAllConnections() {
		if (this.initialConnection) {
			this.initialConnection.abort()
			this.initialConnection = undefined
		}
		for (const connection of this.connections.keys()) connection.abort()
		this.siteHandlerInvoker.abortLast()
		this.checksumSentry = {}

		let reset = false
		if (this.firstChunk && this.data.state !== 'completed' &&
			(!this.lastChunk || !this.data.canResume)) {
			this.currentSize -= this.firstChunk.currentSize
			this.firstChunk = undefined
			this.lastChunk = undefined
			this.chunkStorage!.reset()
			reset = true
		}
		this.connections.clear()
		this.timer.stop()
		this.startTime = undefined
		void this.syncProgressAfterWrites(reset)
	}

	pause() {
		if (!DownloadState.canPause(this.data.state)) return
		this.logger.i(M.i_pause)
		this.update({ state: "paused" })
		MultithreadedTask.startQueuedTasksTimer.startOnce()
		this.removeAllConnections()
	}

	remove() {
		if (this.data.state === 'downloading')
			this.update({ state: "paused" })
		this.removeAllConnections()
		if (this.chunkStorage) this.chunkStorage.delete()
		if (this.data.fileAccessId !== undefined)
			void removeBrowserDownload(this.data.fileAccessId)
		super.remove()
		MultithreadedTask.startQueuedTasksTimer.startOnce()
	}

	fail(error: Error) {
		if (this.data.state === 'failed') return
		const e = ReportedError.convert(error, M.e_unknownError)
		this.logger.e(e.fullMessage, e.detail)
		this.update({ state: "failed", error: error.message })
		MultithreadedTask.startQueuedTasksTimer.startOnce()
		this.removeAllConnections()
	}

}
Task.registerType(MultithreadedTask)

class Chunk {
	constructor(
		public prev: Chunk | undefined,
		readonly startPosition: number,
		readonly write: ChunkStorageWriter,
	) {
		if (prev) {
			this.next = prev.next
			prev.next = this
			assert(startPosition > prev.startPosition)
			assert(!this.next || startPosition <= this.next.startPosition)
		} else {
			assert(startPosition === 0)
		}
	}

	next?: Chunk

	currentSize = 0
	writtenSize = 0
	readonly writeCriticalSection = new CriticalSection()
	writeSentry = {}

	initCurrentSize(size: number) { this.currentSize = this.writtenSize = size }

	get totalSize() {
		return this.next!.startPosition - this.startPosition // Infinity if unknown
	}
	get remainingSize() { return this.totalSize - this.currentSize }
	get currentPosition() { return this.startPosition + this.currentSize }
}
