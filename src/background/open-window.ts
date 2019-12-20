import { remoteProxy } from "../util/webext/remote.js";
import { S } from "./settings.js";
import { isWebExtOOPDisabled } from "./webext-oop.js";

const windowSizes: Record<string, [number, number]> = {
	'/dialog/create.html': [700, 600],
	'/dialog/edit.html': [700, 320],
	'/panel/panel.html': [500, 350],
}

const dialogWindowIds = new Set<number>()
let lastDialogWindowId: number | undefined

export async function openPopupWindow(url: string) {
	if (!browser.windows /* Android */) {
		await browser.tabs.create({ url, active: true })
		return
	}

	const { pathname } = new URL(url, location.href)
	let [width, height] = windowSizes[pathname] || [500, 600]
	let left: number | undefined, top: number | undefined
	if (S.windowSize === 'remember') {
		const value = localStorage.getItem(`windowExtents.${pathname}`)
		if (value) ({ width, height } = JSON.parse(value))
	}
	if (S.windowPosition === 'remember') {
		const value = localStorage.getItem(`windowExtents.${pathname}`)
		if (value) ({ left, top } = JSON.parse(value))
	} else if (S.windowPosition === 'parentCenter') {
		const centerAt = await browser.windows.getLastFocused()
		left = Math.max(0, centerAt.left! +
			Math.floor((centerAt.width! - width) / 2))
		top = Math.max(0, centerAt.top! +
			Math.floor((centerAt.height! - height) / 2))
	}

	// Bug 1402110 unlikely to be fixed (window is blank without webext-oop)
	if (isWebExtOOPDisabled) height++

	const { id, width: newWidth, height: newHeight, left: newLeft, top: newTop,
		tabs, focused } = (await browser.windows.create({
			url, type: 'popup', width, height, left, top,
			incognito: S.openWindowIncognito || undefined,
		}))!
	if (pathname.startsWith('/dialog/')) {
		dialogWindowIds.add(id!)
		if (focused) lastDialogWindowId = id
	}
	if (newWidth !== width || newHeight !== height) // privacy.resistFingerprinting
		await browser.windows.update(id!, { width, height })
	if (newLeft !== left || newTop !== top)
		await browser.windows.update(id!, { left, top })

	if (isWebExtOOPDisabled && tabs && tabs.length)
		await browser.tabs.executeScript(tabs[0].id!, {
			code: `window.postMessage({type: 'workaroundBlankPopup',
				height: ${Number(--height)}}, '*')`
		}).catch(() => { })
}

browser.windows.onRemoved.addListener(id => {
	dialogWindowIds.delete(id)
	if (lastDialogWindowId === id) lastDialogWindowId = undefined
})

async function dialogAlwaysOnTopHandler(windowId: number) {
	if (dialogWindowIds.has(windowId)) {
		lastDialogWindowId = windowId
		return
	}
	if (lastDialogWindowId === undefined) return
	if ((await browser.windows.get(windowId)).type !== 'normal') return
	try {
		if ((await browser.windows.get(lastDialogWindowId)).state === 'minimized')
			return
		void browser.windows.update(lastDialogWindowId, { focused: true })
	} catch { }
}

export function updateDialogAlwaysOnTopHandler() {
	if (S.dialogAlwaysOnTop) {
		browser.windows.onFocusChanged.addListener(dialogAlwaysOnTopHandler)
	} else {
		browser.windows.onFocusChanged.removeListener(dialogAlwaysOnTopHandler)
		lastDialogWindowId = undefined
	}
}

export async function openOptions() {
	if (S.showOptionsInDedicatedTab) {
		const optionsRemote = remoteProxy<import('../options/options')
			.OptionsRemote>('OptionsRemote')
		if (await optionsRemote.activateDedicated()) return
		void browser.tabs.create({ url: browser.runtime.getManifest().options_ui!.page })
	} else
		void browser.runtime.openOptionsPage()
}
