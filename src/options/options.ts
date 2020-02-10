import "../common/elements/x-tab.js"
import { applyI18n, applyI18nAttr } from "../util/webext/i18n.js";
import {
	backgroundRemote, getBuiltinActionContentType, removeBrowserDownload, isValidProtocolURL
} from "../common/common.js";
import { registerRemoteHandler } from "../util/webext/remote.js";
import { remoteSettings, Settings } from "../common/settings.js";
import { importTemplate } from "../util/dom.js";

applyI18n()
applyI18nAttr('label')
applyI18nAttr('placeholder')

const iconColorDetails = document.getElementById('icon-color-details')!

type InputElements = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
type InputCallback = (input: InputElements) => unknown
const inputCallbacks = new Map<keyof Settings, InputCallback>([
	['iconColor', input => {
		iconColorDetails.classList.toggle('visible', input.value === 'custom')
	}],
])

for (const input of document.querySelectorAll(
	'[data-key]') as NodeListOf<InputElements>) {
	const key = input.dataset.key!
	remoteSettings.get(key as any).then(value => {
		if (input.type === 'checkbox')
			(input as HTMLInputElement).checked = value
		else
			input.value = '' + value
		void (inputCallbacks.get(key as keyof Settings) || (_ => 0))(input)
	})
	input.addEventListener('change', () => {
		if (!input.checkValidity()) return
		let value: any
		if (input.type === 'number') {
			value = (!input.required && !input.value) ? '' : Number(input.value)
		} else if (input.type === 'checkbox')
			value = (input as HTMLInputElement).checked
		else value = input.value
		void remoteSettings.set({ [key]: value })
		void (inputCallbacks.get(key as keyof Settings) || (_ => 0))(input)
	})
}

async function getCurrentDedicatedTab() {
	const tab = await browser.tabs.getCurrent()
	if (tab && tab.url &&
		tab.url.toLowerCase().startsWith(location.origin.toLowerCase()))
		return tab
	return undefined
}

export class OptionsRemote {
	async activateDedicated() {
		const tab = await getCurrentDedicatedTab()
		if (!tab) return false
		void browser.tabs.update(tab.id!, { active: true })
		void browser.windows.update(tab.windowId!, { focused: true })
		return true
	}
}
const optionsRemoteRegister = registerRemoteHandler(new OptionsRemote)

remoteSettings.get('showOptionsInDedicatedTab').then(async value => {
	if (!value || await getCurrentDedicatedTab()) return
	optionsRemoteRegister.destroy()
	void backgroundRemote.openOptions()
	location.href = 'about:blank'
})

backgroundRemote.getFallbackEncoding().then(value => {
	(document.querySelector('input[data-key="legacyFilenameEncoding"]') as
		HTMLInputElement).placeholder = value
})

document.querySelector('#play-all-completed-sound')!.addEventListener('click', () => {
	void backgroundRemote.playAllCompletedSound()
})

const configureMonitorURLs = new Set()
for (const type of ['open', 'save'] as const) {
	const anchor = document.getElementById(
		`configure-monitor-builtin-${type}`) as HTMLAnchorElement
	anchor.href = URL.createObjectURL(new File(
		['You can now close or remove this file.'],
		`Configure.MDM-${type.toUpperCase()}`,
		{ type: getBuiltinActionContentType(type) }))
	configureMonitorURLs.add(anchor.href)
}
browser.downloads.onChanged.addListener(async ({ id, state }) => {
	if (state && state.current === 'complete') {
		const download = await browser.downloads.search({ id })
		if (download.length && configureMonitorURLs.has(download[0].url)) {
			try { await browser.downloads.removeFile(id) } catch { }
			void removeBrowserDownload(id)
		}
	}
})

const autoImportContainer = document.getElementById('auto-import-container')!

class AutoImportExtItemElement extends HTMLElement {
	static readonly tagName = 'auto-import-ext-item'
	static readonly parent = document.getElementById('auto-import-ext-list')!

	static get(id: string) {
		return this.parent.querySelector(
			`${this.tagName}[data-id="${CSS.escape(id)}"]`
		) as AutoImportExtItemElement | null
	}

	private checkbox!: HTMLInputElement

	init(id: string, checked: boolean) {
		this.append(importTemplate('auto-import-ext-item-template'))
		this.dataset.id = id
		this.checkbox = this.querySelector('input')!
		this.checkbox.checked = checked
		this.checkbox.addEventListener('change', () => {
			const autoImportExtList = ([...AutoImportExtItemElement
				.parent.getElementsByTagName(this.tagName)] as this[])
				.filter(v => v.checkbox.checked)
				.map(v => ({ id: v.dataset.id!, name: v.name }))
			void remoteSettings.set({ autoImportExtList })
		})
	}

	private _name = ''
	get name() { return this._name }
	set name(value: string) {
		this.querySelector('span')!.textContent = this._name = value
	}
}
customElements.define(AutoImportExtItemElement.tagName, AutoImportExtItemElement)

function addAutoImportExtItem(id: string, name: string, initChecked: boolean) {
	let item = AutoImportExtItemElement.get(id)
	if (item) { item.name = name; return }
	item = new AutoImportExtItemElement()
	item.init(id, initChecked)
	item.name = name
	AutoImportExtItemElement.parent.append(item)
}

function tryAddAutoImportExtItem(download: browser.downloads.DownloadItem) {
	if (!isValidProtocolURL(download.url)) return
	const id = download.byExtensionId
	if (!id || id === browser.runtime.id) return
	addAutoImportExtItem(id, download.byExtensionName || '', false)
}

document.getElementById('open-auto-import')!.addEventListener('click', async () => {
	AutoImportExtItemElement.parent.innerHTML = ''
	for (const v of await remoteSettings.get('autoImportExtList'))
		addAutoImportExtItem(v.id, v.name, true)
	for (const download of await browser.downloads.search({}))
		tryAddAutoImportExtItem(download)
	autoImportContainer.hidden = false
})

for (const modalContainer of document.querySelectorAll(
	'.modal-container') as NodeListOf<HTMLElement>) {
	modalContainer.addEventListener('click', event => {
		if (event.target !== modalContainer) return
		modalContainer.hidden = true
	})
	const modalClose = modalContainer.querySelector('.modal-close')
	if (modalClose) modalClose.addEventListener('click', () => {
		modalContainer.hidden = true
	})
}

browser.downloads.onCreated.addListener(download => {
	if (!autoImportContainer.hidden) tryAddAutoImportExtItem(download)
})

const filenameSearchContainer = document.getElementById('filename-search-container')!
document.getElementById('open-filename-search')!.addEventListener('click', () => {
	filenameSearchContainer.hidden = false
})