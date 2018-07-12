applyI18n()

document.querySelector('#cancel')!.addEventListener('click', closeWindow)

function setInputValues(options: Partial<TaskOptions>) {
	for (const key of Object.keys(options) as (keyof typeof options)[])
		if (options[key] !== undefined)
			(document.getElementById(toHyphenCase(key)) as HTMLInputElement)
				.value = '' + options[key]
}

const monitorPort = function () {
	const match = /^#\/(monitor\/.+)$/.exec(location.hash)
	if (!match) return undefined
	void ((document.querySelector('#continue')! as HTMLElement).hidden = false)
	const port = browser.runtime.connect(undefined, { name: match[1] })
	bindPortToPopupWindow(port)
	port.onMessage.addListener((message: any) => {
		if (message.name === 'options') {
			setInputValues(message.options)
			if (message.contentLength != null) {
				document.getElementById('prompt-file-size-label')!.hidden = false
				document.getElementById('prompt-file-size-value')!.textContent
					= formatSize(message.contentLength)
			}
		} else if (message.name === 'link-without-range')
			(document.querySelector('#link-without-range') as
				HTMLElement).hidden = false
	})
	return port
}()

const taskId = function () {
	if (monitorPort) return undefined
	const match = /^#\/(\d+)$/.exec(location.hash)
	if (!match) return undefined
	const result = Number(match[1])
	return Number.isInteger(result) ? result : undefined
}()

document.querySelector('#main-form')!.addEventListener('submit', async event => {
	event.preventDefault()
	const options = new TaskOptions({})
	for (const key of Object.keys(options) as (keyof TaskOptions)[])
		options[key] = (document.getElementById(
			toHyphenCase(key)) as HTMLInputElement).value
	const id = taskId !== undefined ?
		(await backgroundRemote.setTaskOptions(taskId, options), taskId) :
		await backgroundRemote.createTask(options)
	await backgroundRemote.callTaskMethod(id, 'start')
	void closeWindow()
})

document.querySelector('#continue')!.addEventListener('click', event => {
	if (monitorPort) monitorPort.postMessage({ name: 'continue' })
	void closeWindow()
})

let urlChanged = false
document.getElementById('url')!.addEventListener('input', () => {
	if (!urlChanged) {
		urlChanged = true
		document.getElementById('prompt-file-size-span')!.classList.add('obsolete')
	}
})

const clipboardReader = document.querySelector('#clipboard-reader') as HTMLElement

if (!monitorPort && taskId === undefined)
	window.addEventListener('load', () => { clipboardReader.focus() })

clipboardReader.addEventListener('focus', () => {
	document.execCommand('paste')
	const clipboardValue = clipboardReader.textContent

	const urlInput = document.querySelector('#url')! as HTMLInputElement
	if (clipboardValue) try {
		const url = new URL(clipboardValue)
		if (isValidProtocol(url.protocol))
			urlInput.value = url.href
	} catch { }
	urlInput.focus()
})

void async function () {
	if (taskId !== undefined) {
		(document.querySelector('#url-warning')! as HTMLElement).hidden = false
		const options = await backgroundRemote.getTaskOptions(taskId)
		if (options) setInputValues(options)
	} else {
		const options = { maxThreads: 1, minChunkSize: 1, maxRetries: 1 }
		for (const key of Object.keys(options) as (keyof typeof options)[])
			options[key] = await Settings.get(key)
		setInputValues(options)
	}
}()