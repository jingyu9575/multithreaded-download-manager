import { SimpleStorage } from "../util/storage.js";
import { M } from "../util/webext/i18n.js";
import { remoteSettings } from "./settings.js";

browser.windows.getCurrent().then(({ id: thisId, type, left, top, width, height }) => {
	if (type !== 'popup') return
	const key = `windowExtents.${location.pathname}`

	let altExtentVars = (left === screenX && top === screenY &&
		width === outerWidth && height === outerHeight)
	browser.windows.onRemoved.addListener(id => {
		// If the tab is detached and the popup window is auto-closed, disable saving
		if (id === thisId) altExtentVars = false
	})

	window.addEventListener('beforeunload', () => {
		if (altExtentVars) {
			// Save the extents from alternative variables
			localStorage.setItem(key, JSON.stringify({
				left: screenX, top: screenY, width: outerWidth, height: outerHeight
			}))
		}
		browser.windows.getCurrent().then(({ id, left, top, width, height }) => {
			if (id !== thisId) return
			localStorage.setItem(key, JSON.stringify({ left, top, width, height }))
		})
	})
})

document.documentElement.dataset.path = location.pathname
	.toLowerCase().replace(/^\//, '').replace(/\.html$/i, '')

const subtitle = document.body.dataset.subtitle as keyof I18nMessages
function updateDocumentTitle(suffix = M.extensionName) {
	document.title = subtitle ? `${M[subtitle]} - ${suffix}` : suffix
}
updateDocumentTitle()

void async function () {
	const { theme, iconColor, shortenTabTitle } = await remoteSettings.load([
		'theme', 'iconColor', 'shortenTabTitle',
	])
	document.documentElement.dataset.theme = theme
	if (theme) {
		const node = document.createElement('link')
		node.rel = 'stylesheet'
		node.href = `/common/theme/${encodeURIComponent(theme)}.css`
		document.head.appendChild(node)
	}

	if (document.body.dataset.disableCustomCss === undefined) {
		const storage = await SimpleStorage.create('etc')
		const css = await storage.get('customCSS')
		if (css) {
			const node = document.createElement('style')
			node.textContent = String(css)
			document.head.appendChild(node)
		}
	}

	if (iconColor.startsWith('alt-')) {
		const link = document.querySelector('link[rel="icon"]') as HTMLLinkElement
		link.setAttribute('href', `/icons/alt/${iconColor}.svg`)
	}

	if (shortenTabTitle) updateDocumentTitle(shortenTabTitle)
}()

const domContentLoaded = new Promise(resolve =>
	document.addEventListener("DOMContentLoaded", resolve))

window.addEventListener("message", event => {
	if (event.source == window && event.data &&
		event.data.type == "workaroundBlankPopup") {
		domContentLoaded.then(() =>
			browser.windows.update(browser.windows.WINDOW_ID_CURRENT,
				{ height: event.data.height }))
	}
})