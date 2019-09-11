import { M } from "../util/webext/i18n.js";
import { DownloadState, taskActions, taskActionPrefix, TaskData } from "../common/task-data.js";
import { openPopupWindow } from "./open-window.js";
import { Task, taskSyncRemote } from "./task.js";
import { S, localSettings } from "./settings.js";
import { isValidProtocolURL } from "../common/common.js";
import { Timer } from "../util/promise.js";
import silenceSound from '../sounds/silence.ogg.js'

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

async function openPanelIn(position: 'tab' | 'window' | 'sidebar') {
	if (position === 'tab') {
		if (await taskSyncRemote.activateTab()) return
		await browser.tabs.create({ url: panelURL })
	} else if (position === 'window') {
		if (await taskSyncRemote.activateWindow()) return
		await openPopupWindow(panelURL)
	} else if (position === 'sidebar') {
		await browser.sidebarAction.open()
	}
}

let contextMenuIds: (string | number)[] = []
function recreateContextMenus() {
	for (const id of contextMenuIds) void browser.menus.remove(id)
	const suffix = S.contextMenuIconColor ? `-${S.contextMenuIconColor}` : ''

	contextMenuIds = [
		browser.menus.create({
			title: M.openInNewTab,
			contexts: ['browser_action'],
			icons: { 16: `/icons/toolbar-menu${suffix}/tab.svg` },
			onclick: () => openPanelIn('tab')
		}),
		browser.menus.create({
			title: M.openInNewWindow,
			contexts: ['browser_action'],
			icons: { 16: `/icons/toolbar-menu${suffix}/window.svg` },
			onclick: () => openPanelIn('window')
		}),
		browser.menus.create({
			title: M.openInSidebar,
			contexts: ['browser_action'],
			icons: { 16: `/icons/toolbar-menu${suffix}/sidebar.svg` },
			onclick: () => openPanelIn('sidebar')
		}),
		...taskActions.map(([key]) => browser.menus.create({
			id: key ? taskActionPrefix + key : undefined,
			title: key ? M[key] : undefined,
			contexts: ['image', 'link', 'page', 'selection'],
			documentUrlPatterns: [panelURL],
			type: key ? 'normal' : 'separator',
			icons: key ? { 16: `/icons/menu${suffix}/${key}.svg` } : undefined,
		}))
	]
}
localSettings.listen('contextMenuIconColor', recreateContextMenus)

browser.browserAction.onClicked.addListener(() => {
	if (S.iconClickAction === 'default') return
	openPanelIn(S.iconClickAction)
})
localSettings.listen('iconClickAction', value => {
	void browser.browserAction.setPopup({ popup: value !== 'default' ? '' : null })
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

let showTooltipTimer = new Timer(() => {
	browser.browserAction.setTitle({ title: S.showTooltip ? Task.getTooltip() : null })
})
function updateTooltip(hasProgressing = !!Task.countProgressing()) {
	if (S.showTooltip) showTooltipTimer.onTimer()
	if (S.showTooltip && hasProgressing)
		showTooltipTimer.start(2000)
	else
		showTooltipTimer.stop()
}
localSettings.listen('showTooltip', value => {
	if (!value) showTooltipTimer.onTimer()
	updateTooltip()
}, 'skip' /* called in updateBadge */)

let wakeLockAudio: HTMLAudioElement | undefined
function updateWakeLock(hasProgressing = !!Task.countProgressing()) {
	if (S.inhibitSleep && hasProgressing) {
		if (!wakeLockAudio) {
			wakeLockAudio = new Audio(silenceSound)
			wakeLockAudio.loop = true
		}
		wakeLockAudio.play()
	} else {
		if (wakeLockAudio) wakeLockAudio.pause()
	}
}
localSettings.listen('inhibitSleep', () => updateWakeLock(),
	'skip' /* called in updateBadge */)

Task.updateBadge = async function (suggestedState?: DownloadState) {
	const state = !(await taskSyncRemote.isAlive()) &&
		(suggestedState === 'completed' || suggestedState === 'failed') ?
		suggestedState : undefined
	const n = Task.countProgressing()

	updateTooltip(!!n)
	updateWakeLock(!!n)

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
