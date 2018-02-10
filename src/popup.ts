bindPortToPopupWindow(browser.runtime.connect(undefined, { name: 'subscribe' }))

applyI18n()
function applyTitleI18n(node: NodeSelector) {
	for (const v of node.querySelectorAll(
		'[data-i18n-title]') as NodeListOf<HTMLElement>)
		v.title = browser.i18n.getMessage(v.dataset['i18nTitle']!)
}
applyTitleI18n(document)

function formatSize(n: number,
	{ base = 1024, valueCap = 1000, separator = ' ' } = {}) {
	if (n === 0) return '0'
	const sign = n < 0 ? (n = -n, '-') : ''
	const symbols = ['', 'K', 'M', 'G', 'T', 'P', 'E']
	let exp = Math.floor(Math.log(n) / Math.log(base))
	if (n / base ** exp >= valueCap) exp++
	exp = Math.max(0, Math.min(exp, symbols.length - 1))
	return sign + (n / base ** exp).toFixed(1) + separator + symbols[exp]
}

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

const confirmOverlay = document.querySelector('#confirm-overlay') as HTMLElement
let confirmDeferred = new Deferred<boolean>()
document.querySelector('#confirm-ok')!.addEventListener('click', () => {
	confirmOverlay.hidden = true
	confirmDeferred.resolve(true)
})
document.querySelector('#confirm-cancel')!.addEventListener('click', () => {
	confirmOverlay.hidden = true
	confirmDeferred.resolve(false)
})
function showConfirm(message = '') {
	document.querySelector('#confirm-text')!.textContent = message
	confirmOverlay.hidden = false
	confirmDeferred.resolve(false)
	confirmDeferred = new Deferred<boolean>()
	return confirmDeferred.promise
}

const tasksDiv = document.getElementById('tasks')!
const taskTemplate = document.getElementById('task-template') as HTMLTemplateElement

interface TaskDisplayData extends TaskUpdateData { node: HTMLDivElement }
const taskDisplayDataMap = new Map<number, TaskDisplayData>()

function getProgressCanvas(data: TaskDisplayData) {
	const canvas = data.node.querySelector('.progress-canvas') as HTMLCanvasElement
	const context = canvas.getContext('2d')!
	context.fillStyle = DownloadState.colors[data.state]
	return { canvas, context }
}

function updateTask(id: number, updateData: Partial<TaskUpdateData>) {
	let data = taskDisplayDataMap.get(id)
	if (!data) {
		const node = document.createElement('div')
		node.classList.add('task')
		node.dataset.id = id + ''
		node.setAttribute('contextmenu', 'task-context-menu')
		node.appendChild(document.importNode(taskTemplate.content, true))
		tasksDiv.appendChild(node)

		data = { node, chunks: {}, currentSize: 0, threadCount: 0, state: 'paused' }
		taskDisplayDataMap.set(id, data)

		applyTitleI18n(node)
		node.querySelector('.pause')!.addEventListener('click', async () => {
			if (data!.pauseIsStop && !await showConfirm(
				browser.i18n.getMessage('confirmPauseIsStop'))) return
			backgroundRemote.callTaskMethod(id, 'pause')
		})
		node.querySelector('.start')!.addEventListener('click',
			() => { backgroundRemote.callTaskMethod(id, 'start') })
		node.querySelector('.copy-link')!.addEventListener('click', event => {
			if ((event as MouseEvent).shiftKey) {
				if (data!.referrer)
					void browser.tabs.create({ url: data!.referrer })
				return
			}
			const writer = document.querySelector('#clipboard-writer') as HTMLElement
			writer.textContent = data!.url || ''
			const range = document.createRange()
			range.selectNode(writer)
			window.getSelection().removeAllRanges()
			window.getSelection().addRange(range)
			document.execCommand('Copy')
		})

		node.querySelector('.edit')!.addEventListener('click',
			() => { backgroundRemote.openPopupWindow(`edit.html#/${id}`) })
		node.querySelector('.remove')!.addEventListener('click', async event => {
			if (data!.state === 'completed') {
				if ((event as MouseEvent).shiftKey) {
					if (!await showConfirm(
						browser.i18n.getMessage('confirmDeleteFile')))
						return
					try {
						await browser.downloads.removeFile(data!.fileAccessId!)
					} catch { }
				}
			} else if (!await showConfirm(browser.i18n.getMessage('confirmRemove')))
				return
			void backgroundRemote.callTaskMethod(id, 'remove')
		})
		node.querySelector('.open-file')!.addEventListener('click', async event => {
			try {
				await browser.downloads[((event as MouseEvent).shiftKey) ?
					'show' : 'open'](data!.fileAccessId!)
			} catch (error) {
				data!.node.querySelector('.comment')!.textContent =
					browser.i18n.getMessage('deleted')
			}
		})
	}

	if (updateData.chunks) Object.assign(data.chunks, updateData.chunks)
	if (updateData.canceled) {
		for (const position of Object.keys(data.chunks) as any[])
			delete data.chunks[position]
		data.currentSize = 0
		updateData.canceled = undefined
	}
	for (const key of Object.keys(updateData) as (keyof TaskUpdateData)[])
		if (updateData[key] !== undefined && key !== 'chunks')
			data[key] = updateData[key]

	const { canvas, context } = getProgressCanvas(data)
	function drawChunks(chunks: { [id: number]: number }) {
		if (!data || !data.totalSize /* == 0, == undefined */) return
		for (const [position, currentSize] of Object.entries(chunks))
			context.fillRect(Number(position) / data.totalSize * canvas.width, 0,
				Number(currentSize) / data.totalSize * canvas.width, canvas.height)
	}
	if (updateData.state) {
		const icon = data.node.querySelector('.state-icon') as HTMLElement
		icon.querySelector('use')!.setAttribute('href',
			`icons/bytesize-symbols.svg#i-${{
				downloading: 'play', paused: 'pause', saving: 'archive',
				failed: 'close', completed: 'checkmark'
			}[data.state]}`)
		icon.style.color = DownloadState.colors[updateData.state]
		icon.querySelector('title')!.textContent =
			updateData.state === 'failed' ? data.error || '' : ''
		context.clearRect(0, 0, canvas.width, canvas.height)
		drawChunks(data.chunks)

		const primaryButtonMap = {
			downloading: 'pause', saving: 'pause', paused: 'start',
			failed: 'start', completed: 'open-file',
		}
		for (const cls of Object.values(primaryButtonMap))
			(data.node.querySelector(`.${cls}`) as HTMLElement).hidden =
				cls !== primaryButtonMap[data.state]
		void ((data.node.querySelector(`.pause`)! as HTMLButtonElement).disabled =
			!DownloadState.canPause(data.state))
		void ((data.node.querySelector(`.edit`)! as HTMLButtonElement).disabled =
			!DownloadState.canStart(data.state))
	} else if (updateData.chunks) {
		drawChunks(updateData.chunks)
	}
	if (updateData.pauseIsStop !== undefined) {
		const pauseNode = data.node.querySelector('.pause') as HTMLElement
		pauseNode.classList.toggle('pause-is-stop', data.pauseIsStop)
		pauseNode.title = browser.i18n.getMessage(data.pauseIsStop ? 'stop' : 'pause')
	}

	const percentage = Math.floor(
		data.currentSize / (data.totalSize || NaN) * 1000) / 10
	const texts = {
		filename: data.filename || getSuggestedFilenameFromURL(data.url || ''),
		averageSpeed: data.isPreallocating ? browser.i18n.getMessage('preallocating') :
			(data.averageSpeed ? formatSize(data.averageSpeed) : '-- ') + 'B/s',
		currentSize: formatSize(data.currentSize) + 'B',
		totalSize: data.totalSize != undefined ?
			formatSize(data.totalSize) + 'B' : '?',
		percentage: !Number.isFinite(percentage) ? '--%' :
			percentage.toFixed(percentage === 100 ? 0 : 1) + '%',
		estimatedTime: data.totalSize && data.averageSpeed ? formatTimeSpan((
			data.totalSize - data.currentSize) / data.averageSpeed) : '--:--'
	} as any
	for (const key in texts) if (texts[key] !== undefined) {
		const textNode = data.node.querySelector(`.${toHyphenCase(key)}`)!
		if (textNode.textContent !== texts[key])
			textNode.textContent = texts[key]
	}
	data.node.querySelector('.pause')
}

class BroadcastRemote {
	update(dataArray: [number, Partial<TaskUpdateData>][]) {
		for (const [id, data] of dataArray)
			updateTask(id, data)
	}
	setTaskOrder(ids: number[]) {
		let i = -ids.length - 1
		for (const id of ids) {
			const data = taskDisplayDataMap.get(id)
			if (data) data.node.style.order = i + ''
			i++
		}
	}
	notifyRemove(id: number) {
		const data = taskDisplayDataMap.get(id)
		if (data) data.node.remove()
		taskDisplayDataMap.delete(id)
	}
}
registerMessageRemoteHandler('remote-broadcast', new BroadcastRemote())

function findTargetTask(event: Event) {
	const nullResult = { id: undefined, node: undefined, data: undefined }
	let node = event.target as HTMLElement
	for (; ; node = node.parentElement as HTMLElement) {
		if (node.tagName.toLowerCase() === 'button') return nullResult
		if (!node || node === event.currentTarget)
			return nullResult
		if (node.classList.contains('task')) break
	}
	const id = Number(node.dataset.id)
	return { id, node, data: taskDisplayDataMap.get(id) }
}

tasksDiv.addEventListener('dblclick', event => {
	const { data } = findTargetTask(event)
	if (!data) return
	const button = data.node.querySelector(
		'button.primary:not([hidden])') as HTMLButtonElement
	if (button && !button.disabled)
		button.dispatchEvent(new MouseEvent('click', { shiftKey: event.shiftKey }))
})

document.querySelector('#create')!.addEventListener('click',
	() => { backgroundRemote.openPopupWindow('edit.html') })
document.querySelector('#import')!.addEventListener('click',
	() => { backgroundRemote.openPopupWindow('import.html') })
document.querySelector('#options')!.addEventListener('click',
	() => { browser.runtime.openOptionsPage() })

backgroundRemote.checkStorageAccess().then(hasAccess => {
	if (!hasAccess) document.querySelector('#empty-tasks')!.textContent =
		browser.i18n.getMessage('noStorageAccess')
})