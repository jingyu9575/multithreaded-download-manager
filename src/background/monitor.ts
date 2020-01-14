import { openPopupWindow } from "./open-window.js";
import { S, localSettings } from "./settings.js";
import { TaskData } from "../common/task-data.js";
import { resolveFilenameTemplate } from "./filename-template.js";
import { parseContentDisposition } from "./content-disposition.js";
import { Task } from "./task.js";
import { getBuiltinActionContentType, cryptoRandomString } from "../common/common.js";

type OnHeadersReceivedDetails = Parameters<Parameters<
	typeof browser.webRequest.onHeadersReceived.hasListener>[0]>[0]
type BlockingResponse = browser.webRequest.BlockingResponse

const CONTENT_TYPE_EXCLUDES = new Set([
	'x-xpinstall', 'x-shockwave-flash', 'json', 'xml',
	'javascript', 'x-javascript', 'ecmascript', 'x-ecmascript',
])

function isContentTypeIncluded(type: string) {
	type = type.toLowerCase()
	if (S.monitorAudioFiles && type.startsWith('audio/')) return true
	const PREFIX = 'application/'
	if (!type.startsWith(PREFIX)) return false
	type = type.slice(PREFIX.length)
	const plus = type.lastIndexOf('+')
	if (plus !== -1) type = type.slice(plus + 1)
	if (type === 'pdf' && !S.monitorPDFFiles) return false
	return !CONTENT_TYPE_EXCLUDES.has(type)
}

// Note: do not use another browser.runtime.onConnect in background page
const portListeners = new Map<string, (port: browser.runtime.Port) => void>()
browser.runtime.onConnect.addListener(async port => {
	const listener = portListeners.get(port.name)
	if (!listener) return
	portListeners.delete(port.name)
	listener(port)
})

type HttpHeader = browser.webRequest.HttpHeaders[number]

const cachedMarker = 'x-multithreaded-download-manager-cached-marker-' +
	cryptoRandomString()

const redirectedPostRequests: { requestId: string, timeStamp: number }[] = []

function monitorDownloadListener({
	requestId, method, url, originUrl, responseHeaders, statusCode, tabId, type,
	timeStamp,
}: OnHeadersReceivedDetails): BlockingResponse | Promise<BlockingResponse> {
	if (statusCode >= 301 && statusCode <= 303 && method.toLowerCase() !== 'get') {
		// request is redirected with GET, but still shows as POST in the next callback
		if (redirectedPostRequests.find(v => v.requestId === requestId)) return {}
		redirectedPostRequests.push({ requestId, timeStamp })
		// remove old records
		const minTimeStamp = timeStamp - 90 * 1000
		const i = redirectedPostRequests.findIndex(v => v.timeStamp > minTimeStamp)
		redirectedPostRequests.splice(0, i)
		return {}
	}

	if (!(statusCode >= 200 && statusCode < 300)) return {}
	if (method.toLowerCase() !== 'get') {
		const i = redirectedPostRequests.findIndex(v => v.requestId === requestId)
		if (i === -1) return {}
		redirectedPostRequests.splice(i, 1)
	}

	let contentTypeIncluded = false, acceptRanges = false
	let contentLength: number | undefined
	let contentDispositionHeader: HttpHeader | undefined
	let contentTypeHeader: HttpHeader | undefined
	let cachedMarkerHeader: HttpHeader | undefined

	for (const header of responseHeaders!) {
		const name = header.name.toLowerCase()
		if (name === 'content-disposition') {
			contentDispositionHeader = header
		} else if (name === 'content-length') {
			if (header.value && Number.isSafeInteger(Number(header.value))) {
				contentLength = Number(header.value)
				if (contentLength < S.monitorDownloadMinSize * 1024)
					return {}
			} else if (!S.monitorLinksWithoutRange)
				return {}
		} else if (name === 'content-type') {
			contentTypeHeader = header
			let contentType = header.value || ''
			const semicolon = contentType.indexOf(';')
			if (semicolon !== -1) contentType = contentType.slice(0, semicolon)
			contentType = contentType.trim()
			contentTypeIncluded = isContentTypeIncluded(contentType)
		} else if (name === 'accept-ranges') {
			acceptRanges = (header.value || '').toLowerCase() === 'bytes'
		} else if (name === cachedMarker) {
			cachedMarkerHeader = header
		}
	}
	if (contentLength === undefined) acceptRanges = false
	if (!acceptRanges && !S.monitorLinksWithoutRange) return {}
	const isAttachment = contentDispositionHeader && /attachment\b/i.test(
		(contentDispositionHeader.value || '').trimStart())
	if (!cachedMarkerHeader && !isAttachment && !contentTypeIncluded) return {}

	const paramData = { url, referrer: originUrl || '' }
	const completeData = {
		...TaskData.default(), ...paramData,
		substituteFilename: parseContentDisposition(
			contentDispositionHeader && contentDispositionHeader.value || '')
	}

	const closeBlankTab = async () => {
		try {
			if (!S.autoCloseBlankTab) return
			if (type !== 'main_frame' || tabId === -1) return
			const { url, windowId } = await browser.tabs.get(tabId)
			if (url !== 'about:blank') return
			if (browser.windows /* Android */ && (await browser.windows.get(
				windowId!, { populate: true })).tabs!.length <= 1) return
			await browser.tabs.remove(tabId)
		} catch { }
	}

	if (S.monitorDownloadType === 'downloadDirectly') {
		void Task.create(completeData)
		closeBlankTab()
		return { cancel: true }
	}

	const portName = `monitor-${encodeURIComponent(requestId)}`
	const popupURL = new URL(browser.runtime.getURL('dialog/edit.html'))
	const params = popupURL.searchParams
	params.set('portName', portName)
	for (const [key, value] of Object.entries(paramData)) params.set(key, value)
	params.set('filenameTemplate', resolveFilenameTemplate(completeData))
	if (contentLength !== undefined) params.set('totalSize', contentLength + '')
	if (!acceptRanges) params.set('noRange', '1')

	const setHeader = (name: string, value: string, header?: HttpHeader) => {
		if (header) {
			header.value = value
			header.binaryValue = undefined
		} else
			responseHeaders!.push({ name, value })
	}

	const result = new Promise<BlockingResponse>(resolve => {
		portListeners.set(portName, async port => {
			// Bug 1392067 fixed in Firefox 61 (onDisconnect not fired on close)
			port.onDisconnect.addListener(() => resolve({ cancel: true }))
			port.onMessage.addListener(({ action, type, filenameTemplate }: any) => {
				if (action === 'continue') {
					if (type === 'default') { resolve({}); return }
				}
				setHeader('Content-Type', getBuiltinActionContentType(type),
					contentTypeHeader)
				const filename = resolveFilenameTemplate(
					{ ...completeData, filenameTemplate })
				setHeader('Content-Disposition',
					`inline; filename*=UTF-8''${encodeURIComponent(filename)}`,
					contentDispositionHeader)
				setHeader(cachedMarker, '1', cachedMarkerHeader)
				resolve({ responseHeaders })
			})
		})
		setTimeout(() => { if (portListeners.delete(portName)) resolve({}) }, 15000)
	})
	result.then(({ cancel }) => { if (cancel) closeBlankTab() })

	openPopupWindow(popupURL.href)
	return result
}
localSettings.listen('monitorDownload', value => {
	if (value)
		browser.webRequest.onHeadersReceived.addListener(monitorDownloadListener, {
			urls: ['http://*/*', 'https://*/*'],
			types: ['main_frame', 'sub_frame'],
		}, ['blocking', 'responseHeaders'])
	else
		browser.webRequest.onHeadersReceived.removeListener(monitorDownloadListener)
})
