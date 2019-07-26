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

browser.downloads.onChanged.addListener(({ id, state, error }) => {
	if (state && state.current === 'complete') resolveBrowserDownload(id)
	if (error && error.current) {
		const type = error.current.split('_')[0]
		const result = new ReportedError(({
			FILE: M.e_saveFileError, NETWORK: M.e_networkError,
			SERVER: M.e_serverError, USER: M.e_saveFileError,
		} as { [type: string]: string })[type] || M.e_unknownError, error.current)
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
