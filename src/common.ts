class Deferred<T> {
	promise: Promise<T>
	resolve: (value?: T | PromiseLike<T>) => void
	reject: (reason?: any) => void

	constructor() {
		this.promise = new Promise((resolve, reject) => {
			this.reject = reject
			this.resolve = resolve
		})
	}
}

function remoteDispatch(obj: any, event: any) {
	if (!event || !(event.name in obj)) return
	return obj[event.name](...event.args)
}

function addAsyncMessageListener(name: string, handler: (data: any) => any) {
	browser.runtime.onMessage.addListener(
		(message: any, sender: any, sendResponse: any) => {
			if (!(message && message.name === name)) return false
			Promise.resolve(handler(message.data))
				.then(sendResponse, () => sendResponse(undefined))
			return true
		})
}

function registerMessageRemoteHandler(name: string, handler: object) {
	addAsyncMessageListener(name, data => remoteDispatch(handler, data))
}

function remoteProxy(sendMessage: (message: any) => any) {
	return new Proxy({}, {
		get(target, name, receiver) {
			return (...args: any[]) => sendMessage({ name, args })
		}
	})
}

function messageRemoteProxy(name: string) {
	return remoteProxy(data => browser.runtime.sendMessage({ name, data }))
}

type DownloadState = 'downloading' | 'saving' | 'paused' | 'completed' | 'failed'
const DownloadState = {
	isProgressing(state: DownloadState) {
		return ['downloading', 'saving'].includes(state)
	},
	canPause(state: DownloadState) {
		return ['downloading'].includes(state)
	},
	canStart(state: DownloadState) {
		return ['paused', 'failed'].includes(state)
	},
	canWriteChunks(state: DownloadState) {
		return ['downloading', 'paused', 'failed'].includes(state)
	},
	colors: {
		downloading: 'cornflowerblue',
		saving: 'cornflowerblue',
		failed: 'red',
		paused: 'goldenrod',
		completed: 'green',
	},
}

class TaskOptions {
	url: string = ''
	filename?: string = undefined
	referrer?: string = undefined
	maxThreads?: number = undefined
	minChunkSize?: number = undefined // KiB
	maxRetries?: number = undefined

	constructor(source: Partial<TaskOptions>) { Object.assign(this, source) }
}

interface TaskUpdateData {
	state: DownloadState
	error?: string
	url?: string
	referrer?: string
	filename?: string
	totalSize?: number
	currentSize: number
	threadCount: number
	averageSpeed?: number
	chunks: { [id: number]: number }
	fileAccessId?: number
	pauseIsStop?: boolean
	canceled?: boolean
}

class Settings {
	version = 0

	badgeType = 'number' as 'none' | 'number'
	hideBadgeZero = false
	addContextMenuToLink = true
	windowPosition = 'parentCenter' as 'default' | 'parentCenter'
	newTaskAtTop = true
	removeCompletedTasksOnStart = false

	monitorDownload = false
	monitorDownloadMinSize = 1024 // KiB
	monitorDownloadInclude = ''
	monitorDownloadExclude = ''
	autoCloseBlankTab = true

	maxThreads = 4
	minChunkSize = 1024 // KiB
	maxRetries = 5

	legacyFilenameEncoding = ''
	legacyFilenameDetectUTF8 = true
	legacyFilenameDetectURLEncoded = true

	removeAfterImport = true

	taskOrder: number[] = []

	static async load(keys: (keyof Settings)[] | null = null) {
		const result = await browser.storage.local.get(keys) as Readonly<Settings>
		Object.setPrototypeOf(result, new Settings())
		return result
	}

	static async get<K extends keyof Settings>(key: K) {
		return (await this.load([key]))[key]
	}

	static async set(data: Partial<Settings>) {
		await browser.storage.local.set(data)
	}

	private static listeners = new Map<string, (value: any) => void>()
	private static listenersRegistered = false

	static setListener<K extends keyof Settings>(key: K,
		callback?: (value?: Settings[K]) => void) {
		if (!Settings.listenersRegistered) {
			Settings.listenersRegistered = true
			browser.storage.onChanged.addListener((changes: {
				[field: string]: { oldValue?: any, newValue?: any }
			}, areaName: string) => {
				if (areaName !== 'local') return
				for (const key in changes) {
					const listener = Settings.listeners.get(key)
					if (listener) listener(changes[key].newValue)
				}
			})
		}
		callback ? Settings.listeners.set(key, callback)
			: Settings.listeners.delete(key)
	}
}

function applyI18n() {
	for (const v of document.querySelectorAll('[data-i18n]') as
		NodeListOf<HTMLElement>)
		v.innerText = browser.i18n.getMessage(v.dataset['i18n']!)
}

if (!browser.windows) browser.windows = {
	WINDOW_ID_CURRENT: -2,
	async get() { return { tabs: await browser.tabs.query({}) } },
	async remove(id: number) {
		if (id === browser.windows.WINDOW_ID_CURRENT) {
			const tab = await browser.tabs.getCurrent()
			if (tab) await browser.tabs.remove(tab.id!)
		}
	},
	getLastFocused() { return undefined },
	update() { },
	async create({ url }: { url: string }) {
		await browser.tabs.create({ url, active: true })
	}
} as any

async function closeWindow() {
	await browser.windows.remove(browser.windows.WINDOW_ID_CURRENT)
}

function isValidProtocol(protocol: string) {
	return ['http:', 'https:'].includes(protocol.toLowerCase())
}

function getSuggestedFilenameFromURL(url: string) {
	let result = ''
	try {
		result = new URL(url).pathname.replace(new URL('.', url).pathname, '')
		result = decodeURIComponent(result) // separate assignment
	} catch { }
	return result || 'download'
}

async function removeBrowserDownload(id: number) {
	try { await browser.downloads.cancel(id) } catch { }
	try { await browser.downloads.erase({ id }) } catch { }
}

function toHyphenCase(s: string) {
	return s.replace(/[a-z][A-Z]/g, g => g[0] + '-' + g[1].toLowerCase())
}

async function openPopupWindow(url: string) {
	const position = await Settings.get('windowPosition')
	const centerAt = position === 'parentCenter' ?
		await browser.windows.getLastFocused() : undefined
	const width = 500, height = 300
	const { id } = await browser.windows.create({ url, type: 'popup', width, height })
	if (centerAt) {
		await browser.windows.update(id!, {
			left: Math.max(0, centerAt.left! +
				Math.floor((centerAt.width! - width) / 2)),
			top: Math.max(0, centerAt.top! +
				Math.floor((centerAt.height! - height) / 2)),
		})
	}
}
