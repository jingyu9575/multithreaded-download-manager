declare global { interface I18nMessages { } }

export function applyI18n(node: ParentNode = document) {
	for (const v of node.querySelectorAll('[data-i18n]') as NodeListOf<HTMLElement>)
		v.innerText = browser.i18n.getMessage(v.dataset['i18n']!)
}

export function applyI18nAttr(attr: string, node: ParentNode = document) {
	const key = `data-i18n-${attr}`
	for (const v of node.querySelectorAll(`[${key}]`) as NodeListOf<HTMLElement>)
		v.setAttribute(attr, browser.i18n.getMessage(v.getAttribute(key)!))
}

export const M: I18nMessages & {
	(key: keyof I18nMessages, ...subs: (string | number)[]): string
} = new Proxy((() => { }) as any, {
	get(_target, key: string) {
		return browser.i18n.getMessage(key)
	},
	apply(_target, _that, args: [string, ...(string | number)[]]) {
		const [key, ...subs] = args
		return browser.i18n.getMessage(key, subs)
	},
})