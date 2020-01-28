import {
	DownloadState, MultithreadedTaskData, TaskProgressItems
} from "../common/task-data.js";
import { ChunkStorage, ChunkStorageClass, ChunkStorageWriter } from "./chunk-storage.js";
import { Connection, ConnectionClass, StreamFilterConnection } from "./connection.js";
import { Task } from "./task.js";
import { assert, ReportedError, isAbortError, abortError } from "../util/error.js";
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

function getPreferredClass<
	V extends { readonly isAvailable: boolean }, K extends string, P extends K
>(
	implementations: { [key in K]: V }, preference: P) {
	if (implementations[preference].isAvailable)
		return implementations[preference]
	return undefined
}

export class MultithreadedTask extends Task<MultithreadedTaskData> {
	private chunkStorageClass!: ChunkStorageClass
	private readonly connectionClass: ConnectionClass =
		MultithreadedTask.getPreferredConnectionClass() || StreamFilterConnection

	static getPreferredConnectionClass() {
		return getPreferredClass(Connection.implementations, S.connectionAPI)
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
	private chunkStorage!: ChunkStorage

	private currentSize = 0
	private startTime?: number
	private startSize = 0
	private lastFlushTime = 0
	private lastFlushInterval = Infinity
	private lastFlushIntervalScaled = Infinity

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
		const promises = connections.map(c => this.pipeConnectionToChunk(c, now))
		if (!this.updatedChunks.size) return

		const chunks = [...this.updatedChunks]
		this.updatedChunks.clear()
		const firstChunkSentry = this.firstChunk
		setTimeout(() => {
			if (firstChunkSentry !== this.firstChunk) return
			this.syncProgress(this.getProgress(chunks))
		}, 200)

		await Promise.all(promises)

		const { flushInterval } = this.chunkStorage
		if (flushInterval !== this.lastFlushInterval) {
			this.lastFlushInterval = flushInterval
			this.lastFlushIntervalScaled = flushInterval * 1000 - 100
			this.logger.i(M('i_segmentsInterval', flushInterval))
		}
		if (now - this.lastFlushTime > this.lastFlushIntervalScaled) {
			this.lastFlushTime = now
			for (const chunk of this.connections.values())
				void chunk.writer.flush()
		}
		this.persistChunks()
	}, 1000)

	private readonly cachedConnectionTimes = new class {
		private data: { start: number, time: number }[] = Array(16)
		private position = 0

		push(item: { start: number, time: number }) {
			this.data[this.position] = item
			this.position++
			if (this.position >= this.data.length) this.position = 0
		}

		average() {
			const now = performance.now()
			let total = 0
			let weights = 0
			for (const v of this.data) {
				if (!v) continue
				const weight = 1 / Math.max(now - v.start, 1)
				weights += weight
				total += weight * v.time
			}
			return weights ? total / weights : 0 // default to zero connection time
		}

		clear() { this.data = Array(this.data.length) }
	}

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

		// new tasks without storageAPI will use setting or default
		const defaultStorageAPI = 'MutableFile' // use it until removed by Firefox
		const dataRW: MultithreadedTaskData = this.data
		if (!this.data.storageAPI)
			dataRW.storageAPI = S.storageAPI || defaultStorageAPI
		const fallbackStorageAPI = 'SegmentedFile'
		let chunkStorageClass = getPreferredClass(ChunkStorage.implementations,
			this.data.storageAPI!)
		let initError: Error | undefined
		if (!chunkStorageClass) {
			initError = new ReportedError(M.e_APIUnsupported, this.data.storageAPI)
			dataRW.storageAPI = fallbackStorageAPI
			chunkStorageClass = ChunkStorage.implementations[fallbackStorageAPI]
		}

		this.chunkStorageClass = chunkStorageClass
		this.chunkStorage = new this.chunkStorageClass(this.id)
		this.chunkStorage.onError.listen(error => this.failStorage(error))
		await this.chunkStorage.init(isLoaded)

		if (isLoaded && this.data.totalSize !== undefined) {
			if (DownloadState.areChunksFinished(this.data.state)) {
				this.firstChunk = new Chunk(undefined,
					new ChunkStorageWriter(undefined, 0, this.data.totalSize))
				this.lastChunk = new Chunk(this.firstChunk,
					new ChunkStorageWriter(undefined, this.data.totalSize))
				this.currentSize = this.data.totalSize
			} else if (this.data.canResume) {
				let chunk: Chunk | undefined = undefined
				this.currentSize = 0
				for (const w of (await this.chunkStorage.load(this.data.totalSize))
					.sort((v0, v1) => v0.startPosition - v1.startPosition)) {
					chunk = new Chunk(chunk, w)
					if (!this.firstChunk) this.firstChunk = chunk
					this.currentSize += chunk.currentSize
				}
				if (chunk) this.lastChunk = new Chunk(chunk,
					new ChunkStorageWriter(undefined, this.data.totalSize))
			}
		}

		if (DownloadState.isProgressing(this.data.state) &&
			this.data.state !== 'queued') {
			Object.assign(this.data, { state: 'paused' })
			if (!initError) this.start()
		}

		if (!isLoaded) this.update({}) // persist
		if (initError) setImmediate(() => this.fail(initError!))
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
		this.logger.i(M('i_api', this.connectionClass.name,
			this.chunkStorageClass.name))
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

			this.firstChunk = new Chunk(undefined, this.chunkStorage.writer(0))
			const { totalSize } = info
			this.lastChunk = new Chunk(this.firstChunk, new ChunkStorageWriter(undefined,
				totalSize !== undefined ? totalSize : Infinity))

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
		this.lastFlushTime = performance.now()
		this.lastFlushInterval = this.lastFlushIntervalScaled = Infinity
		this.timer.start()
	}

	private persistChunks() {
		if (DownloadState.areChunksFinished(this.data.state)) return
		if (!this.data.canResume) return
		void this.chunkStorage.persist(this.data.totalSize, false)
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
			}), () => { void this.onConnectionComplete(connection) }, {
			expectedSize: this.data.totalSize !== undefined ?
				this.data.totalSize - position : undefined,
			requestSubstituteFilename: isInitial,
		})
		connection.info.then(() => {
			if (connection.lastTransferTime === undefined) return
			this.cachedConnectionTimes.push({
				start: connection.startTime,
				time: connection.lastTransferTime - connection.startTime,
			})
		})
		return connection
	}

	private setChunkConnection(chunk: Chunk, connection = this.createConnection(
		chunk.writer.startPosition + chunk.currentSize, false)) {
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
		this.updatedChunks.add(chunk)
		await chunk.writer.write(writtenData)
		return false
	}

	protected getProgress(chunks = [...this.getChunks()]) {
		const items: TaskProgressItems = {}
		for (const { currentSize, writer: { startPosition, writtenSize } } of chunks)
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
		const chunk = this.connections.get(connection)
		if (!chunk) return

		if (!error) do {
			// wait for stop event if prepare() returns void
			await (connection.prepare() || new Promise(setImmediate))
		} while (!await this.pipeConnectionToChunk(connection))
		// must flush before connection is deleted
		await this.flushBeforeRemove.sync(() => chunk.writer.flush())
		this.persistChunks()

		if (!this.connections.get(connection)) return
		// no connection rebinding; assert(connection <=> chunk)
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

		let minChunkSize = this.data.minChunkSize * 1024
		if (S.dynamicMinChunkSize) {
			minChunkSize = Math.max(minChunkSize, (this.averageSpeed || 0) *
				(this.cachedConnectionTimes.average() / 1000))
		}
		for (const divisible of divisibles) {
			// avoid too small chunks
			let spaceSize
			do {
				spaceSize = Math.floor(divisible.size / (divisible.count + 1))
				if (spaceSize > 0 && spaceSize >= minChunkSize) break
				divisible.count--
			} while (divisible.count > 0)
			let { chunk } = divisible
			let position = chunk.currentPosition
			for (let i = 0; i < divisible.count; i++) {
				position += spaceSize
				chunk = new Chunk(chunk, this.chunkStorage.writer(position))
				this.setChunkConnection(chunk)
			}
		}
	}

	async saveFile() {
		this.startTime = undefined
		assert(!this.connections.size)
		await this.flushBeforeRemove.sync(() => { })// all chunks have been flushed

		if (this.data.state !== 'downloading') return
		this.logger.i(M.i_save)
		this.update({ state: 'saving' })
		MultithreadedTask.startQueuedTasksTimer.startOnce()

		// prepare to get file
		await this.chunkStorage.persist(this.data.totalSize, true)

		const saveAs = {
			systemDefault: undefined, downloadFolder: false, alwaysAsk: true,
		}[S.saveFileTo]

		try {
			await this.verifyChecksum()
			const blobURL = URL.createObjectURL(await this.chunkStorage.getFile())
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
				...(this.data.totalSize === undefined ?
					{ totalSize: this.currentSize } : {})
			})
			this.chunkStorage.reset()
		} catch (error) {
			if (!isAbortError(error)) this.fail(error)
			this.persistChunks()
		}
	}

	private async verifyChecksum() {
		const { checksum } = this.data
		if (!checksum) return

		const hash = new (checksum.length === 64 ? Sha256 : Sha1)
		const sentry = this.checksumSentry = {}
		for await (const v of this.chunkStorage.readSlices(this.currentSize)) {
			if (this.checksumSentry !== sentry) throw abortError()
			hash.process(new Uint8Array(v))
		}
		hash.finish()

		const result = [...hash.result!].map(
			v => v.toString(16).padStart(2, '0')).join('')
		this.logger.i(M('i_checksum', result, checksum))
		if (result.toLowerCase() !== checksum.toLowerCase())
			throw new ReportedError(M.e_checksumError)
	}

	private readonly flushBeforeRemove = new CriticalSection()

	private removeAllConnections() {
		if (this.initialConnection) {
			this.initialConnection.abort()
			this.initialConnection = undefined
		}
		for (const connection of this.connections.keys()) connection.abort()
		this.siteHandlerInvoker.abortLast()
		this.checksumSentry = {}
		this.cachedConnectionTimes.clear()

		if (this.firstChunk && this.data.state !== 'completed' &&
			(!this.lastChunk || !this.data.canResume)) {
			this.currentSize -= this.firstChunk.currentSize
			this.firstChunk = undefined
			this.lastChunk = undefined
			this.chunkStorage.reset()
			// no need to flush after reset
			this.syncProgress({ reset: true, ...this.getProgress() })
		} else {
			const firstChunkSentry = this.firstChunk
			// (async) flush all active chunks; syncProgress
			const chunks = [...this.connections.values()]
			this.flushBeforeRemove.sync(() => Promise.all(
				chunks.map(chunk => chunk.writer.flush())
			)).then(() => {
				if (firstChunkSentry !== this.firstChunk) return
				this.syncProgress(this.getProgress(chunks))
			})
		}

		this.connections.clear()
		this.timer.stop()
		this.startTime = undefined
	}

	pause() {
		if (!DownloadState.canPause(this.data.state)) return
		this.logger.i(M.i_pause)
		this.update({ state: "paused" })
		MultithreadedTask.startQueuedTasksTimer.startOnce()
		this.removeAllConnections()
		this.persistChunks()
	}

	reset() {
		if (this.data.state === 'saving') return
		this.logger.i(M.i_reset)
		this.update({ state: "paused", fileAccessId: null, totalSize: undefined })
		this.lastChunk = undefined
		MultithreadedTask.startQueuedTasksTimer.startOnce()
		this.currentSize = this.firstChunk ? this.firstChunk.currentSize : 0
		this.removeAllConnections()
	}

	remove() {
		if (this.data.state === 'downloading')
			this.update({ state: "paused" })
		this.removeAllConnections()
		if (this.chunkStorage as ChunkStorage | undefined)
			this.chunkStorage.delete()
		if (this.data.fileAccessId != undefined && S.cascadeBuiltinTask)
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

	failStorage(error: Error) {
		for (const chunk of this.getChunks()) {
			this.currentSize += chunk.writer.writtenSize - chunk.currentSize
			chunk.currentSize = chunk.writer.writtenSize
		}
		this.syncProgress({ reset: true, ...this.getProgress() })
		this.fail(error)
	}
}
Task.registerType(MultithreadedTask)

class Chunk {
	constructor(
		public prev: Chunk | undefined,
		readonly writer: ChunkStorageWriter,
	) {
		if (prev) {
			this.next = prev.next
			prev.next = this
			assert(writer.startPosition > prev.writer.startPosition)
			assert(!this.next ||
				writer.startPosition <= this.next.writer.startPosition)
		} else {
			assert(writer.startPosition === 0)
		}
		this.currentSize = this.writer.writtenSize
	}

	next?: Chunk
	currentSize: number

	get totalSize() {
		return this.next!.writer.startPosition -
			this.writer.startPosition // Infinity if unknown
	}
	get remainingSize() { return this.totalSize - this.currentSize }
	get currentPosition() { return this.writer.startPosition + this.currentSize }
}
