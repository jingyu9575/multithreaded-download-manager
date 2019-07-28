import { remoteProxy } from "../util/webext/remote.js";
import { S } from "./settings.js";
import { isWebExtOOPDisabled } from "./webext-oop.js";

const windowSizes: Record<string, [number, number]> = {
	'/dialog/create.html': [700, 600],
	'/dialog/edit.html': [700, 320],
	'/panel/panel.html': [500, 350],
}

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

	const { id, width: newWidth, height: newHeight, left: newLeft, top: newTop, tabs } =
		(await browser.windows.create({ url, type: 'popup', width, height, left, top }))!
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

export async function openOptions() {
	if (S.showOptionsInDedicatedTab) {
		const optionsRemote = remoteProxy<import('../options/options')
			.OptionsRemote>('OptionsRemote')
		if (await optionsRemote.activateDedicated()) return
		void browser.tabs.create({ url: browser.runtime.getManifest().options_ui!.page })
	} else
		void browser.runtime.openOptionsPage()
}
