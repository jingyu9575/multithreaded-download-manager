import { M } from "../util/webext/i18n.js";
import { DownloadState, taskActions, taskActionPrefix, TaskData } from "../common/task-data.js";
import { openPopupWindow } from "./open-window.js";
import { Task, taskSyncRemote } from "./task.js";
import { S, localSettings } from "./settings.js";
import { isValidProtocol, isValidProtocolURL } from "../common/common.js";

void async function () {
	const iconColor = S.iconColor
	const [iconColorCode, iconColorAlpha] = ({
		darker: ['#0c0c0d', 85],
		lighter: ['#f9f9fa', 85],
	} as Record<string, [string, number]>)[iconColor] || [undefined, 0]
	if (iconColorCode)
		await localSettings.post({ iconColor: 'custom', iconColorCode, iconColorAlpha })

	if (S.windowSize === '500x300' as string)
		await localSettings.post({ windowSize: 'default' })

	await localSettings.post({ version: 1 })
}()

browser.runtime.onInstalled.addListener(({ reason }) => {
	if (reason !== 'install') return
	void localSettings.post({ monitorDownload: true })
})

browser.runtime.onUpdateAvailable.addListener(() => {
	if (Task.countProgressing()) return
	browser.runtime.reload()
})

if (navigator.storage && navigator.storage.persist)
	void navigator.storage.persist()

const panelURL = browser.runtime.getManifest().browser_action!.default_popup!

browser.menus.create({
	title: M.openInNewTab,
	contexts: ['browser_action'],
	icons: { 16: '/icons/toolbar-menu/tab.svg' },
	onclick: async () => { browser.tabs.create({ url: panelURL }) }
})
browser.menus.create({
	title: M.openInNewWindow,
	contexts: ['browser_action'],
	icons: { 16: '/icons/toolbar-menu/window.svg' },
	onclick: async () => { openPopupWindow(panelURL) }
})

const linkMenuId = browser.menus.create({
	id: 'link-context-menu',
	title: M('downloadWith', M.extensionName),
	contexts: ['link', 'selection'],
	documentUrlPatterns: ['http://*/*', 'https://*/*'],
	onclick: function ({ linkUrl, selectionText }, { url: tabURL }) {
		if (selectionText !== undefined || !isValidProtocolURL(linkUrl)) {
			openPopupWindow(browser.runtime.getURL(
				'/dialog/create.html?selectedLinks=1'))
			return
		}
		const data = { url: linkUrl || '', referrer: tabURL! }
		if (S.addContextMenuToLinkType === 'askForOptions') {
			const url = new URL(browser.runtime.getURL('/dialog/edit.html'))
			url.search = new URLSearchParams(data) + ''
			openPopupWindow(url.href)
			return
		}
		void Task.create({ ...TaskData.default(), ...data })
	},
	visible: false,
})
localSettings.listen('addContextMenuToLink', value => {
	browser.menus.update(linkMenuId, { visible: value })
})

for (const [key] of taskActions) {
	browser.menus.create({
		id: key ? taskActionPrefix + key : undefined,
		title: key ? M[key] : undefined,
		contexts: ['image', 'link', 'page', 'selection'],
		documentUrlPatterns: [panelURL],
		type: key ? 'normal' : 'separator',
		icons: key ? { 16: `/icons/menu/${key}.svg` } : undefined,
	})
}

Task.updateBadge = async function (suggestedState?: DownloadState) {
	const state = !(await taskSyncRemote.isAlive()) &&
		(suggestedState === 'completed' || suggestedState === 'failed') ?
		suggestedState : undefined
	const n = Task.countProgressing()
	if (S.badgeType === 'none' || !(state || n) ||
		(state === 'completed' && !n && S.hideBadgeZero)) {
		await browser.browserAction.setBadgeText({ text: '' })
		return
	}
	await browser.browserAction.setBadgeTextColor({ color: 'white' })
	await browser.browserAction.setBadgeText({ text: `${n}` })
	await browser.browserAction.setBadgeBackgroundColor(
		{ color: DownloadState.colors[state || 'downloading'] })
}
localSettings.listen('badgeType', () => void Task.updateBadge(), 'skip')
localSettings.listen('hideBadgeZero', () => void Task.updateBadge())

const originalIconSVG = fetch('/icons/icon.svg').then(r => r.text())
	.then(s => new DOMParser().parseFromString(s, 'image/svg+xml')
		.documentElement as Element)

async function updateIconColor() {
	const { iconColor } = S
	if (iconColor.startsWith('alt-')) {
		browser.browserAction.setIcon({ path: `/icons/alt/${iconColor}.svg` })
		return
	}
	let [iconColorCode, iconColorAlpha] = ({
		'dark': ['#0c0c0d', 70],
		'black': ['#000000', 100],
		'light': ['#f9f9fa', 70],
		'white': ['#ffffff', 100],
	} as Record<string, [string, number]>)[iconColor] || [undefined, 0]
	if (iconColor === 'custom') ({ iconColorCode, iconColorAlpha } = S)
	const hex = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(iconColorCode)
	let color: string | undefined
	if (hex) {
		color = `rgba(${parseInt(hex[1], 16)}, ${parseInt(hex[2], 16)}, ` +
			`${parseInt(hex[3], 16)}, ${iconColorAlpha / 100})`
	} else {
		try {
			// Not needing `theme` permission [Firefox 62]
			const { colors } = await browser.theme.getCurrent()
			if (colors) {
				const c = colors.icons || colors.toolbar_text || colors.bookmark_text
				color = Array.isArray(c) ?
					`${'rgba'.slice(0, c.length)}(${c.join(',')})` : c
			}
		} catch { }
		if (!color) {
			browser.browserAction.setIcon({ path: undefined })
			return
		}
	}

	// toolbar/menupanel icon size is always 16 * devicePixelRatio [Firefox 68.0b5]
	const SIZE_PX = 16
	const size = Math.ceil(SIZE_PX * devicePixelRatio)
	const img = new Image(size, size)
	const node = (await originalIconSVG).cloneNode(true) as SVGSVGElement
	node.style.color = color
	node.setAttribute('width', '' + size)
	node.setAttribute('height', '' + size)

	await new Promise(resolve => {
		img.addEventListener('load', resolve)
		img.src = "data:image/svg+xml," + encodeURIComponent(node.outerHTML)
	})
	img.width = size
	img.height = size

	const canvas = document.createElement('canvas')
	canvas.width = size
	canvas.height = size
	const context = canvas.getContext('2d')!
	context.imageSmoothingEnabled = false
	context.drawImage(img, 0, 0)
	browser.browserAction.setIcon(
		{ imageData: { [SIZE_PX]: context.getImageData(0, 0, size, size) } })
}

// Not needing `theme` permission [Firefox 62]
try { browser.theme.onUpdated.addListener(updateIconColor) } catch { }

localSettings.listen('iconColor', () => void updateIconColor(), 'skip')
localSettings.listen('iconColorCode', () => void updateIconColor(), 'skip')
localSettings.listen('iconColorAlpha', () => void updateIconColor())
