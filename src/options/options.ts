import "../common/elements/x-tab.js"
import { applyI18n, applyI18nAttr } from "../util/webext/i18n.js";
import { backgroundRemote, getBuiltinActionContentType, removeBrowserDownload } from "../common/common.js";
import { registerRemoteHandler } from "../util/webext/remote.js";
import { remoteSettings, Settings } from "../common/settings.js";

applyI18n()
applyI18nAttr('label')
applyI18nAttr('placeholder')

const iconColorDetails = document.getElementById('icon-color-details')!

type InputCallback = (input: HTMLInputElement | HTMLSelectElement) => unknown
const inputCallbacks = new Map<keyof Settings, InputCallback>([
	['iconColor', input => {
		iconColorDetails.classList.toggle('visible', input.value === 'custom')
	}],
])

for (const input of document.querySelectorAll(
	'[data-key]') as NodeListOf<HTMLInputElement | HTMLSelectElement>) {
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