class Deferred<T> {
	promise: Promise<T>
	resolve!: (value?: T | PromiseLike<T>) => void
	reject!: (reason?: any) => void

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
	isPreallocating?: boolean
}

class Settings {
	version = 0

	saveFileTo = 'systemDefault' as 'systemDefault' | 'downloadFolder' | 'alwaysAsk'
	skipFirstSavingAttempt = false
	
	iconColor = 'default' as 'default' | string
	badgeType = 'number' as 'none' | 'number'
	hideBadgeZero = false
	addContextMenuToLink = true
	windowPosition = 'parentCenter' as 'default' | 'parentCenter' | 'remember'
	windowSize = '500x300' as '500x300' | 'remember'
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
	async getLastFocused() { return {} },
	async getCurrent() { return {} },
	async update() { },
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
	const { pathname } = new URL(url, location.href)
	const settings = await Settings.load(['windowPosition', 'windowSize'])
	let width = 500, height = 300,
		left: number | undefined = undefined, top: number | undefined = undefined
	if (settings.windowSize === 'remember') {
		const value = localStorage.getItem(`windowSize.${pathname}`)
		if (value) {
			const obj = JSON.parse(value)
			width = obj.width; height = obj.height
		}
	} else {
		const match = /^(\d+)x(\d+)$/.exec(settings.windowSize)
		if (match) { width = Number(match[1]); height = Number(match[2]) }
	}
	if (settings.windowPosition === 'remember') {
		const value = localStorage.getItem(`windowPosition.${pathname}`)
		if (value) {
			const obj = JSON.parse(value)
			left = obj.left; top = obj.top
		}
	} else if (settings.windowPosition === 'parentCenter') {
		const centerAt = await browser.windows.getLastFocused()
		if (centerAt && centerAt.id !== undefined /*Android*/) {
			left = Math.max(0, centerAt.left! +
				Math.floor((centerAt.width! - width) / 2))
			top = Math.max(0, centerAt.top! +
				Math.floor((centerAt.height! - height) / 2))
		}
	}
	const { id, width: newWidth, height: newHeight } =
		await browser.windows.create({ url, type: 'popup', width, height })
	if (newWidth !== width || newHeight !== height)
		await browser.windows.update(id!, { width, height })
	if (left !== undefined || top !== undefined)
		await browser.windows.update(id!, { left, top })
}

const backgroundRemote = messageRemoteProxy('remote-background') as BackgroundRemote

const isBackground = new URL((browser.runtime.getManifest() as any).background.page,
	location.href).pathname === location.pathname

if (!isBackground) browser.windows.getCurrent().then(({ id, type }) => {
	if (type !== 'popup') return
	window.addEventListener('beforeunload', () => {
		const { pathname } = location
		browser.windows.getCurrent().then(({ id: id1, left, top, width, height }) => {
			if (id !== id1) return
			localStorage.setItem(`windowPosition.${pathname}`,
				JSON.stringify({ left, top }))
			localStorage.setItem(`windowSize.${pathname}`,
				JSON.stringify({ width, height }))
		})
	})
})