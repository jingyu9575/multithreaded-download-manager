import { Deferred } from "../util/promise.js";
import { ReportedError } from "../util/error.js";
import { M } from "../util/webext/i18n.js";

const browserDownloadMap = new Map<number, Deferred<void>>()

function resolveBrowserDownload(id: number, error?: Error) {
	const deferred = browserDownloadMap.get(id)
	if (!deferred) return
	!error ? deferred.resolve() : deferred.reject(error)
	browserDownloadMap.delete(id)
}

export function translateBrowserDownloadError(error: string) {
	if (error === "USER_CANCELED") return M.e_canceled
	const type = error.split('_')[0]
	return ({
		FILE: M.e_saveFileError, NETWORK: M.e_networkError,
		SERVER: M.e_serverError, USER: M.e_saveFileError,
	} as Record<string, string>)[type] || M.e_unknownError
}

browser.downloads.onChanged.addListener(({ id, state, error }) => {
	if (state && state.current === 'complete') resolveBrowserDownload(id)
	if (error && error.current) {
		const result = new ReportedError(
			translateBrowserDownloadError(error.current), error.current)
		resolveBrowserDownload(id, result)
	}
})

browser.downloads.onErased.addListener(id => {
	resolveBrowserDownload(id, new ReportedError(M.e_saveFileError))
})

export function browserDownloadResult(id: number) {
	const deferred = new Deferred<void>()
	browserDownloadMap.set(id, deferred)
	return deferred.promise
}
