import { CriticalSection } from "../util/promise.js";
import { concatTypedArray } from "../util/buffer.js";
import { abortError, ReportedError, isAbortError } from "../util/error.js";
import { parseContentDisposition } from "./content-disposition.js";
import { M } from "../util/webext/i18n.js";
import { cryptoRandomString } from "../common/common.js";

type TypeOfConnection = typeof Connection
export interface ConnectionClass extends TypeOfConnection { }

const connectionHeader = 'x-multithreaded-download-manager-' + cryptoRandomString()

const connectionInitIdMap = new Map<number, Connection>()

type OnBeforeSendHeadersDetails = Parameters<Parameters<
	typeof browser.webRequest.onBeforeSendHeaders.hasListener>[0]>[0]
type OnCompletedDetails = Parameters<Parameters<
	typeof browser.webRequest.onCompleted.hasListener>[0]>[0]
type OnErrorOccurredDetails = Parameters<Parameters<
	typeof browser.webRequest.onErrorOccurred.hasListener>[0]>[0]

export type ConnectionInfo = {
	finalURL: string
	totalSize?: number
	acceptRanges: boolean
	substituteFilename?: string
	error?: undefined
} | { error: Error }

export abstract class Connection {
	static readonly isAvailable: boolean

	private static nextInitId = 1 // Skip 0 to exclude `Number('')`

	readonly info: Promise<ConnectionInfo | undefined>

	private readonly controller = new AbortController()
	private readonly referrer: string

	constructor(request: Request, needInfo: boolean,
		private readonly onFinish: (error?: Error) => void) {
		const initId = Connection.nextInitId++
		request.headers.set(connectionHeader, '' + initId)
		connectionInitIdMap.set(initId, this)
		this.referrer = request.referrer
		const startTime = performance.now()

		this.info = (async () => {
			let response
			try {
				response = await fetch(request, { signal: this.controller.signal })
			} catch (error) {
				if (error && error.name === 'TypeError' &&
					('' + error.message).startsWith('NetworkError'))
					throw new ReportedError(M.e_networkError, error)
				throw error
			} finally {
				connectionInitIdMap.delete(initId)
			}
			if (!response.ok)
				throw new ReportedError(M.e_serverError, response.status)
			this.onResponse(response)

			if (!needInfo) return undefined
			const info: ConnectionInfo = {
				finalURL: response.url,
				acceptRanges: false,
				substituteFilename: '',
			}
			let contentDisposition = ''
			for (const [name, value] of response.headers) {
				const lname = name.toLowerCase()
				if (lname === 'content-length' && value) {
					info.totalSize = Number(value)
					if (!Number.isSafeInteger(info.totalSize))
						info.totalSize = undefined
				} else if (lname === 'accept-ranges') {
					info.acceptRanges = value.toLowerCase() === 'bytes'
				} else if (lname === 'content-disposition') {
					contentDisposition = value
				}
			}

			info.substituteFilename = parseContentDisposition(contentDisposition)
			return info
		})().catch(error => {
			const MIN_ERROR_DELAY = 1000
			const time = performance.now() - startTime
			if (time < MIN_ERROR_DELAY && !isAbortError(error))
				return new Promise(resolve => setTimeout(() => resolve({ error }),
					MIN_ERROR_DELAY - time))
			return { error }
		})
	}

	protected onResponse(_response: Response) { }

	protected pendingData: Uint8Array[] = []
	protected done = false

	prepare(): void | Promise<void> { }

	read() {
		const result = concatTypedArray(this.pendingData)
		if (result && result.length) {
			this.pendingData = []
			return result
		}
		return this.done ? undefined : new Uint8Array()
	}

	abort() { this.controller.abort() }

	onBeforeSendHeaders({ requestHeaders }: OnBeforeSendHeadersDetails) {
		const newHeaders = requestHeaders!.filter(header => {
			const lname = header.name.toLowerCase()
			return lname !== connectionHeader
				&& lname !== 'accept-encoding' && lname !== 'origin'
				&& lname !== 'referer'
		})
		if (this.referrer) newHeaders.push({ name: 'Referer', value: this.referrer })
		return { requestHeaders: newHeaders }
	}

	async onStopped(details: OnCompletedDetails | OnErrorOccurredDetails) {
		const info = await this.info
		let error = info && info.error
		if (!error && 'error' in details)
			error = new ReportedError(M.e_networkError, details.error)
		this.onFinish(this.controller.signal.aborted ? abortError() : error)
	}
}

const connectionRequestIdMap = new Map<string, Connection>()
const connectionRequestFilter: browser.webRequest.RequestFilter = {
	urls: ['<all_urls>'], types: ['xmlhttprequest'],
}

browser.webRequest.onBeforeSendHeaders.addListener(details => {
	for (const header of details.requestHeaders!) {
		if (header.name.toLowerCase() === connectionHeader) {
			const initId = Number(header.value)
			const connection = connectionInitIdMap.get(initId)
			if (connection) {
				connectionRequestIdMap.set(details.requestId, connection)
				return connection.onBeforeSendHeaders(details)
			}
		}
	}
	return {}
}, connectionRequestFilter, ['requestHeaders', 'blocking'])

function onRequestStopped(details: OnCompletedDetails | OnErrorOccurredDetails) {
	const connection = connectionRequestIdMap.get(details.requestId)
	if (!connection) return
	connectionRequestIdMap.delete(details.requestId)
	connection.onStopped(details)
}
browser.webRequest.onErrorOccurred.addListener(onRequestStopped, connectionRequestFilter)
browser.webRequest.onCompleted.addListener(onRequestStopped, connectionRequestFilter)


export class StreamsConnection extends Connection {
	static readonly isAvailable = 'ReadableStream' in window && 'body' in Response.prototype

	private reader?: ReadableStreamReader<Uint8Array>
	private readonly criticalSection = new CriticalSection

	protected onResponse({ body }: Response) { this.reader = body!.getReader() }

	prepare() {
		// Spawn one read() request. 
		// 1. Assume the browser returns all the received data to a single read(), 
		//    which is true for Firefox (tested on 57 and 62) but not Chromium
		// 2. Assume the data are ready after a set delay
		return this.criticalSection.sync(async () => {
			// Do nothing if this.reader is not ready
			if (!this.reader || this.done) return
			try {
				const { value } = await this.reader.read()
				if (value)
					this.pendingData.push(value)
				else
					this.done = true
			} catch {
				this.done = true
			}
		})
	}

	abort() {
		try {
			if (this.reader) void this.reader.cancel()
		} catch (error) { console.error(error) }
		super.abort()
	}
}

export class StreamFilterConnection extends Connection {
	static readonly isAvailable = true

	onBeforeSendHeaders(details: OnBeforeSendHeadersDetails) {
		const result = super.onBeforeSendHeaders(details)
		const filter = browser.webRequest.filterResponseData(
			details.requestId) as browser.webRequest.StreamFilter
		filter.ondata = ({ data }) => {
			this.pendingData.push(new Uint8Array(data))
		}
		filter.onstop = filter.onerror = e => { console.warn(e); this.done = true; filter.close() }

		return result
	}
}