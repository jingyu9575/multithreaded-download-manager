import { SimpleStorage } from "../util/storage.js";
import { M } from "../util/webext/i18n.js";

browser.windows.getCurrent().then(({ id, type }) => {
	if (type !== 'popup') return
	window.addEventListener('beforeunload', () => {
		const { pathname } = location
		browser.windows.getCurrent().then(
			({ id: id1, left, top, width, height }) => {
				if (id !== id1) return
				localStorage.setItem(`windowExtents.${pathname}`,
					JSON.stringify({ left, top, width, height }))
			})
	})
})

document.documentElement!.dataset.path = location.pathname
	.toLowerCase().replace(/^\//, '').replace(/\.html$/i, '')

const subtitle = document.body.dataset.subtitle as keyof I18nMessages
document.title = subtitle ? `${M[subtitle]} - ${M.extensionName}` : M.extensionName

if (document.body.dataset.disableCustomCss === undefined) (async () => {
	const storage = await SimpleStorage.create('etc')
	const css = await storage.get('customCSS')
	if (!css) return
	const node = document.createElement('style')
	node.textContent = String(css)
	document.head!.appendChild(node)
})()
