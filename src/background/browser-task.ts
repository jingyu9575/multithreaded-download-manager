import { Task } from "./task.js";
import { BrowserTaskData, TaskProgress, DownloadState, TaskData } from "../common/task-data.js";
import { Timer } from "../util/promise.js";
import { S } from "./settings.js";
import { translateBrowserDownloadError } from "./browser-download.js";

type OnDownloadChangedDetails = Parameters<Parameters<
	typeof browser.downloads.onChanged.hasListener>[0]>[0]

const browserDownloadStateKeys = ['state', 'paused', 'error'] as const

export class BrowserTask extends Task<BrowserTaskData> {
	// fileAccessId => BrowserTask or undefined (loading)
	private static readonly map = new Map<number, Promise<BrowserTask>>()

	private static readonly refreshSizeTimer = new Timer(async () => {
		let hasInProgress = false
		const items = await browser.downloads.search({})
		const now = Date.now()
		for (const item of items) {
			if (item.state === 'in_progress') hasInProgress = true
			const task = BrowserTask.map.get(item.id)
			if (!task) continue
			task.then(task => {
				task.currentSize = item.bytesReceived
				task.averageSpeed = item.estimatedEndTime && item.totalBytes >= 0 ?
					(item.totalBytes - item.bytesReceived) * 1000 /
					(Date.parse(item.estimatedEndTime) - now) : undefined
				
				// workaround Bug 1391157
				if (item.totalBytes >= 0 && item.totalBytes !== task.data.totalSize)
					task.update({ totalSize: item.totalBytes })

				task.syncProgress(task.getProgress())
			})
		}
		// if (!hasInProgress) BrowserTask.refreshSizeTimer.stop()
	}, 1000)

	static readonly initialization = Task.initialization.then(() => {
		BrowserTask.refreshSizeTimer.start()

	})

	private currentSize = 0
	private averageSpeed?: number
	private browserDownloadState: Pick<browser.downloads.DownloadItem,
		(typeof browserDownloadStateKeys)[number]>
		= { state: 'in_progress', paused: false, error: undefined }

	static load(item: browser.downloads.DownloadItem) {
		if (this.map.has(item.id)) return
		this.map.set(item.id, (this.create({
			...TaskData.default(),
			type: this.name, fileAccessId: item.id, canResume: false,
			url: item.url, referrer: item.referrer,
		}) as Promise<BrowserTask>).then(task => {
			task.change(item)
			return task
		}))
	}

	async init(isLoaded: boolean) { }

	start() { void browser.downloads.resume(this.data.fileAccessId!) }
	pause() { void browser.downloads.pause(this.data.fileAccessId!) }

	protected getProgress(): TaskProgress {
		const { currentSize } = this
		return {
			items: { 0: { currentSize, writtenSize: currentSize } },
			currentSize, averageSpeed: this.averageSpeed, currentWarnings: 0,
			currentThreads: DownloadState.isProgressing(this.data.state) ? 1 : 0,
		}
	}

	private change(item: Partial<browser.downloads.DownloadItem>) {
		const d: Partial<BrowserTaskData> = {}
		if (item.filename !== undefined)
			d.filename = item.filename.replace(/.*[\\\/]/, '')
		if (item.state !== undefined || item.paused !== undefined ||
			item.error !== undefined) {
			for (const key of browserDownloadStateKeys)
				if (item[key] !== undefined)
					(this.browserDownloadState[key] as any) = item[key]
			d.error = null
			if (this.browserDownloadState.state === 'complete') {
				d.state = 'completed'
			} else if (this.browserDownloadState.paused) {
				d.state = 'paused'
			} else if (this.browserDownloadState.error) {
				d.state = 'failed'
				d.error = translateBrowserDownloadError(
					this.browserDownloadState.error)
			} else { d.state = 'downloading' }
		}
		if (item.totalBytes !== undefined)
			d.totalSize = item.totalBytes >= 0 ? item.totalBytes : undefined
		this.update(d)
	}

	static async onDownloadChanged(changes: OnDownloadChangedDetails) {
		const task = await this.map.get(changes.id)
		if (!task) return
		task.change(Object.fromEntries(Object.entries(changes).map(
			([k, v]) => [k, typeof v === 'object' ? v.current : undefined])))
	}
}
Task.registerType(BrowserTask)

browser.downloads.onCreated.addListener(async item => {
	await Task.initialization
	if (!S.manageBrowserDownload) return
	BrowserTask.load(item)
})

browser.downloads.onChanged.addListener(c => BrowserTask.onDownloadChanged(c))