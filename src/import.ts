applyI18n()

document.querySelector('#cancel')!.addEventListener('click', closeWindow)

var backgroundRemote = messageRemoteProxy('remote-background') as BackgroundRemote

const itemList = document.querySelector('#item-list') as HTMLSelectElement
const showCompleted = (document.querySelector('#show-completed') as HTMLInputElement)
const removeAfterImport = (document.querySelector('#remove-after-import') as
	HTMLInputElement)
const itemMap = new WeakMap<HTMLElement, browser.downloads.DownloadItem>()

function getSelectedItems() {
	return [...itemList.childNodes as NodeListOf<HTMLOptionElement>]
		.filter(v => v.selected).map(v => itemMap.get(v)!)
}

function getLeafName(path: string) {
	return path.replace(/^.*[\/\\]/, '')
}

async function reloadItems() {
	let items = await browser.downloads.search({})
	items = items.filter(v => {
		try { return isValidProtocol(new URL(v.url).protocol) }
		catch { return false }
	})
	if (!showCompleted.checked) items = items.filter(v => v.state !== 'complete')

	const oldIds = new Set(getSelectedItems().map(v => v.id))
	itemList.innerHTML = ''
	for (const item of items) {
		const option = document.createElement('option')
		option.title = option.textContent =
			[getLeafName(item.filename), item.url].filter(v => v).join(' - ')
		option.selected = oldIds.has(item.id)
		itemMap.set(option, item)
		itemList.appendChild(option)
	}
}
showCompleted.addEventListener('change', reloadItems)
void reloadItems()

Settings.get('removeAfterImport').then(v => {
	removeAfterImport.checked = v
	removeAfterImport.addEventListener('change', () =>
		Settings.set({ removeAfterImport: removeAfterImport.checked }))
})

document.querySelector('#main-form')!.addEventListener('submit', async event => {
	event.preventDefault()
	for (const item of getSelectedItems()) {
		await backgroundRemote.callTaskMethod(await backgroundRemote.createTask({
			url: item.url,
			filename: getLeafName(item.filename),
			referrer: item.referrer,
		}), 'start')
		if (removeAfterImport.checked) await removeBrowserDownload(item.id)
	}
	void closeWindow()
})