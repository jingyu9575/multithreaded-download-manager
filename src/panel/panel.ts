import { registerRemoteHandler } from "../util/webext/remote.js";
import { applyI18n, applyI18nAttr, M } from "../util/webext/i18n.js";
import {
	DownloadState, TaskData, TaskProgress, TaskProgressItems, TaskSyncBootstrapItem,
	taskActions, TaskActionDetail, taskActionPrefix, MultithreadedTaskData, TaskProgressItem
} from "../common/task-data.js"
import { importTemplate } from "../util/dom.js";
import { formatSize, backgroundRemote } from "../common/common.js";

applyI18n()
applyI18nAttr('title')

function formatTimeSpan(seconds: number) {
	const value = Math.ceil(seconds)
	const hval = Math.floor(value / 3600),
		m = Math.floor((value % 3600) / 60) + '',
		s = (value % 60) + ''
	const cap = 10000
	if (hval >= cap) return `>${cap}h`
	return hval ? `${hval}:${m.padStart(2, '0')}:${s.padStart(2, '0')}` :
		`${m}:${s.padStart(2, '0')}`
}

function formatCompletedDate(date: Date) {
	const now = new Date()
	let format: Intl.DateTimeFormatOptions
	if (date.getFullYear() === now.getFullYear()) {
		if (date.getMonth() === now.getMonth() &&
			date.getDate() === now.getDate())
			format = { hour12: false, hour: '2-digit', minute: '2-digit' }
		else
			format = { month: 'short', day: 'numeric' }
	} else
		format = { year: 'numeric', month: 'short', day: 'numeric' }
	return date.toLocaleString(undefined, format)
}

const pendingWriteMaskColor = 'rgba(255, 255, 255, 0.4)'

const stateIcons = {
	downloading: '../icons/extra-icons.svg#play',
	saving: '../icons/photon-icons.svg#save',
	failed: '../icons/photon-icons.svg#stop',
	paused: '../icons/extra-icons.svg#pause',
	completed: '../icons/photon-icons.svg#check',
	queued: '../icons/photon-icons.svg#history',
}

const taskActionsObject = Object.fromEntries(
	taskActions.filter(([key]) => key) as [string, TaskActionDetail][])

class XTaskElement extends HTMLElement {
	static readonly parent = document.getElementById('tasks')! as HTMLElement

	static get(taskId: number) {
		return document.getElementById('x-task-' + taskId) as XTaskElement | null
	}

	constructor(readonly taskId: number) { super() }

	init(data: TaskData) {
		this.classList.add('task')
		this.appendChild(importTemplate('x-task-template'))
		this.id = 'x-task-' + this.taskId
		this.update(data)

		this.addEventListener('dblclick', ({ target, shiftKey }) => {
			if (this.contains((target as Element).closest('button'))) return
			for (const [key, detail] of taskActions) {
				if (key && detail.primary && this.isActionShown(detail)) {
					this.callAction(key, shiftKey)
					return
				}
			}
		})

		for (const button of this.querySelectorAll(
			'.task-action') as NodeListOf<HTMLElement>) {
			const action = button.dataset.action as keyof I18nMessages
			const shiftAction = taskActionsObject[action].shift
			button.title = shiftAction ?
				M('actionTitleWithShift', M[action], M[shiftAction]) : M[action]
		}

		this.addEventListener('click', ({ target, shiftKey }) => {
			const actionButton = (target as HTMLElement).closest(
				'.task-action') as HTMLButtonElement | null
			if (!actionButton) return
			const action = actionButton.dataset.action
			if (action) this.callAction(action, shiftKey)
		})

		return this
	}

	readonly data: Readonly<TaskData> = {} as TaskData
	readonly progress: TaskProgress = {
		items: [], currentSize: 0, currentThreads: 0, currentWarnings: 0
	}

	update(data: Partial<TaskData>) {
		Object.assign(this.data, data)

		if (data.filename !== undefined ||
			(this.data.filename === undefined && data.url !== undefined)) {
			const span = this.querySelector('.filename') as HTMLElement
			span.textContent = span.title = this.data.filename || 'download'
		}

		if (data.totalSize !== undefined) {
			this.querySelector('.total-size')!.textContent =
				formatSize(data.totalSize) + M.byteSymbol
			this.updateProgressTexts()
		}

		if (data.state !== undefined) {
			this.dataset.state = data.state
			const iconUse = this.querySelector('.state-icon use') as SVGUseElement
			iconUse.setAttribute('href', stateIcons[data.state])
			iconUse.style.color = DownloadState.colors[data.state]
			this.drawProgress(this.progress.items, true)
		}

		if (data.state !== undefined || data.canResume !== undefined) {
			for (const button of this.querySelectorAll(
				'.task-action') as NodeListOf<HTMLElement>) {
				const shown = this.isActionShown(
					taskActionsObject[button.dataset.action!])
				if (shown !== undefined) button.hidden = !shown
			}
		}

		if (data.error !== undefined /* string | null */)
			this.showError(data.error)

		if (data.state === 'completed' || data.completedDate !== undefined)
			if (this.data.state === 'completed' && this.data.completedDate)
				this.showError(formatCompletedDate(this.data.completedDate))

		if ((data as Partial<MultithreadedTaskData>).maxThreads !== undefined ||
			data.canResume !== undefined) {
			this.querySelector('.max-threads')!.textContent = this.data.canResume ?
				(this.data as MultithreadedTaskData).maxThreads + '' : '-'
		}
	}

	private updateProgressTexts() {
		const { currentSize, averageSpeed, currentThreads } = this.progress
		this.querySelector('.average-speed')!.textContent =
			(averageSpeed ? formatSize(averageSpeed) : '-- ')
			+ M.byteSymbol + '/s'
		this.querySelector('.current-size')!.textContent =
			formatSize(currentSize) + M.byteSymbol
		this.querySelector('.current-threads')!.textContent = currentThreads + ''

		if (this.data.totalSize) {
			const percentage = Math.floor(
				currentSize / this.data.totalSize * 1000) / 10
			this.querySelector('.percentage')!.textContent =
				percentage.toFixed(percentage === 100 ? 0 : 1) + '%'

			this.querySelector('.estimated-time')!.textContent = averageSpeed
				? formatTimeSpan((this.data.totalSize - currentSize) / averageSpeed)
				: '--:--'
		}
	}

	updateProgress(value: TaskProgress) {
		if (value.reset)
			for (const key of Object.keys(this.progress.items))
				delete this.progress.items[key as any]
		Object.assign(this.progress.items, value.items)
		this.drawProgress(value.items, !!value.reset)
		this.progress.currentSize = value.currentSize
		this.progress.averageSpeed = value.averageSpeed
		this.progress.currentThreads = value.currentThreads
		this.progress.currentWarnings = value.currentWarnings
		this.updateProgressTexts()
	}

	private drawProgress(items: TaskProgressItems, clear: boolean) {
		const canvas = this.querySelector('.progress-canvas') as HTMLCanvasElement
		const context = canvas.getContext('2d')!
		const { width, height } = canvas

		if (clear) context.clearRect(0, 0, width, height)

		const { totalSize } = this.data
		if (!totalSize /* 0 | undefined */) return

		for (const [key, { currentSize, writtenSize }] of
			Object.entries(items as Record<any, TaskProgressItem>)) {
			const position = Number(key)
			context.fillStyle = DownloadState.colors[this.data.state]

			const x0 = Math.round(position / totalSize * width)
			const xc = Math.round((position + currentSize) / totalSize * width)
			let currentWidth = xc - x0
			if (currentSize && currentWidth < 1) currentWidth = 1
			context.fillRect(x0, 0, currentWidth, height)
			if (writtenSize < currentSize) {
				const xw = Math.round((position + writtenSize) / totalSize * width)
				context.fillStyle = pendingWriteMaskColor
				context.fillRect(xw, 0, xc - xw, height)
			}
		}
	}

	private showError(error?: string | null) {
		this.querySelector('.error')!.textContent = error || ''
		this.classList.toggle('has-error', !!error)
	}

	isActionShown(detail: TaskActionDetail) {
		let hasFilter = false, result = true
		if (detail.filterStates) {
			hasFilter = true
			if (!detail.filterStates.includes(this.data.state)) result = false
		}
		if (detail.filterCanResume !== undefined) {
			hasFilter = true
			if ((this.data.canResume !== false) !== detail.filterCanResume)
				result = false // this.data.canResume default to true
		}
		return hasFilter ? result : 'no-filter'
	}

	callAction(key: string, shiftKey: boolean) {
		if (shiftKey) key = taskActionsObject[key].shift || key
		void (this as any)['action_' + key]()
	}

	action_start() { void backgroundRemote.callTaskMethod(this.taskId, 'start') }
	action_pause() { void backgroundRemote.callTaskMethod(this.taskId, 'pause') }
	action_stop() {
		if (this.progress.currentSize && !confirm(M.confirmPauseIsStop)) return
		this.action_pause()
	}

	async showOrOpenFile(method: 'show' | 'open') {
		try {
			if (this.data.fileAccessId != undefined) {
				await browser.downloads[method](this.data.fileAccessId)
				return
			}
		} catch { }
		this.showError(M.deleted)
	}

	action_openFile() {
		if (this.data.state !== 'completed') return
		void this.showOrOpenFile('open')
	}
	action_openContainingFolder() {
		if (this.data.fileAccessId == undefined) {
			void browser.downloads.showDefaultFolder()
		} else void this.showOrOpenFile('show')
	}

	action_copyLink() { void navigator.clipboard!.writeText(this.data.url) }

	action_openReferrer() {
		if (!this.data.referrer) return
		void browser.tabs.create({ url: this.data.referrer })
	}

	action_viewLogs() {
		const url = new URL(browser.runtime.getURL('/dialog/logs.html'))
		url.searchParams.set('id', '' + this.taskId)
		void browser.tabs.create({ url: url.href })
	}

	action_edit() {
		const url = new URL(browser.runtime.getURL('dialog/edit.html'))
		url.searchParams.set('id', '' + this.taskId)
		void backgroundRemote.openPopupWindow(url.href)
	}

	action_reset() { 
		if (this.progress.currentSize && !confirm(M.confirmReset)) return
		void backgroundRemote.callTaskMethod(this.taskId, 'reset') 
	}

	action_remove() {
		if (this.data.state !== 'completed' && !confirm(M.confirmRemove)) return
		void backgroundRemote.callTaskMethod(this.taskId, 'remove')
	}

	async action_deleteFile() {
		if (this.data.state === 'completed') {
			if (!confirm(M.confirmDeleteFile)) return
			if (this.data.fileAccessId != undefined) try {
				await browser.downloads.removeFile(this.data.fileAccessId)
			} catch { }
		}
		this.action_remove()
	}
}
customElements.define('x-task', XTaskElement)

export class TaskSyncRemote {
	private initialized = false

	init(value: TaskSyncBootstrapItem[]) {
		if (this.initialized) return
		this.initialized = true
		for (const { id, data, progress } of value) {
			this.create(id, data, false)
			this.progress(id, progress)
		}
	}

	create(id: number, data: TaskData, atTop: boolean) {
		if (!this.initialized) return
		XTaskElement.parent[atTop ? 'prepend' : 'append'](
			new XTaskElement(id).init(data))
	}

	update(id: number, data: Partial<TaskData>) {
		const task = XTaskElement.get(id)
		if (task) task.update(data)
	}

	progress(id: number, value: TaskProgress) {
		const task = XTaskElement.get(id)
		if (task) task.updateProgress(value)
	}

	remove(id: number) {
		const task = XTaskElement.get(id)
		if (task) task.remove()
	}

	isAlive() { return true }
	activateTab!: () => Promise<boolean>
	activateWindow!: () => Promise<boolean>
}
registerRemoteHandler(new TaskSyncRemote)

browser.windows.getCurrent().then(({ type }) => {
	const activate = async () => {
		const tab = await browser.tabs.getCurrent()
		void browser.tabs.update(tab.id!, { active: true })
		void browser.windows.update(tab.windowId!, { focused: true })
		return true
	}
	if (type === 'normal') TaskSyncRemote.prototype.activateTab = activate
	if (type === 'popup') TaskSyncRemote.prototype.activateWindow = activate
})

void backgroundRemote.requestTaskSyncInit()

document.getElementById('create')!.addEventListener('click', () => {
	backgroundRemote.openPopupWindow('../dialog/create.html')
})

document.querySelector('#options')!.addEventListener('click', async () => {
	backgroundRemote.openOptions()
	if (!await browser.tabs.getCurrent()) window.close() // close browserAction popup
})

void async function () {
	if (!await backgroundRemote.isStorageAvailable())
		document.getElementById('no-storage-access')!.hidden = false
	if (!await backgroundRemote.isConnectionAPIAvailable())
		document.getElementById('connection-api-unavailable')!.hidden = false
}()

document.addEventListener('contextmenu', event => {
	const task = (event.target as HTMLElement).closest('.task') as XTaskElement | null
	if (task) {
		browser.menus.overrideContext({ showDefaults: false })
		for (const [key, detail] of taskActions) {
			if (!key) continue
			const visible = task.isActionShown(detail)
			if (visible === 'no-filter') continue
			void browser.menus.update(taskActionPrefix + key, { visible })
		}
		void browser.menus.refresh()
	} else {
		event.preventDefault()
	}
}, { capture: true });

browser.menus.onClicked.addListener(info => {
	if (typeof info.menuItemId !== 'string' ||
		!info.menuItemId.startsWith(taskActionPrefix) ||
		info.targetElementId === undefined) return
	let target = browser.menus.getTargetElement(info.targetElementId) as Element | null
	if (!target || !(target instanceof Element)) return
	if (target instanceof SVGElement && target.ownerSVGElement)
		target = target.ownerSVGElement
	const task = target.closest('.task') as XTaskElement | null
	if (!task) return

	const key = info.menuItemId.slice(taskActionPrefix.length)
	if (task.isActionShown(taskActionsObject[key])) task.callAction(key, false)
})