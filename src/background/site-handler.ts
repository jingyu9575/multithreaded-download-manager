import { S } from "./settings.js";
import { ConnectionInfo } from "./connection.js";

interface SiteHandler {
	(url: string, signal: AbortSignal): Promise<Partial<ConnectionInfo>>
}

const siteHandlerMap = new Map<string, SiteHandler>([
	// Google Drive
	['.googleusercontent.com.', async (url, signal) => {
		const { hostname, pathname } = new URL(url)
		if (!/doc-[-\w]+-docs.googleusercontent.com/.test(hostname)) return {}
		const id = pathname.replace(new URL('.', url).pathname, '')
		const response = await fetch(`https://drive.google.com/file/d/${id}/view`,
			{ credentials: "include", signal })
		if (!response.ok) return {}
		const text = await response.text()
		console.log(text)
		const match = /\[null,"[^\r\n]+\[null,(?:null|\d+),"(\d+)"\]/.exec(text)
		if (match && match[1] && Number.isSafeInteger(Number(match[1])))
			return { totalSize: Number(match[1]) }
		return {}
	}],
])

export class SiteHandlerInvoker {
	private lastController?: AbortController

	abortLast() { if (this.lastController) this.lastController.abort() }

	invoke(url: string) {
		if (!S.useSiteHandlers) return undefined
		try {
			let suffix = '.' + new URL(url).hostname.toLowerCase() + '.'
			for (; suffix; suffix = suffix.replace(/.[^.]*/, '')) {
				const hander = siteHandlerMap.get(suffix)
				if (!hander) continue

				const controller = this.lastController = new AbortController()
				setTimeout(() => controller.abort(), 10000)
				return hander(url, controller.signal)
			}
		} catch { }
		return undefined
	}
}