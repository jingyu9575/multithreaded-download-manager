import { filenameSearchPrefix } from "../common/task-data.js"
import { M } from "../util/webext/i18n.js";
import { remoteProxy } from "../util/webext/remote.js";
import { taskSyncRemote, Task } from "./task.js";
import { abortError } from "../util/error.js";

export interface FilenameSearchMenuItem {
	id: string | number,
	title: string,
	url: string,
}

export let filenameSearchMenuItems: FilenameSearchMenuItem[] = []

const panelURL = browser.runtime.getManifest().browser_action!.default_popup!

export function updateFilenameSearchItems(value = '') {
	for (const { id } of filenameSearchMenuItems)
		void browser.menus.remove(id)
	filenameSearchMenuItems = []

	let i = 0
	for (const line of value.split(/\r|\n/)) {
		const m = line.trim().match(/^("(?:""|[^"])*"|\S+)\s+(\S+)/)
		if (!m) continue
		const title = M('searchWith', m[1])
		filenameSearchMenuItems.push({
			id: browser.menus.create({
				id: `${filenameSearchPrefix}${i++}`,
				title,
				contexts: ['image', 'link', 'page', 'selection'],
				documentUrlPatterns: [panelURL],
			}),
			title,
			url: m[2],
		})
	}
	void taskSyncRemote.reloadFilenameSearch()
}

export async function searchFilename(taskIds: number[], urlTemplate: string) {
	const urls: string[] = []
	for (const id of taskIds) {
		const task = Task.get(id)
		if (!task) continue
		const hashes = new Map<string, string>()
		let promise = Promise.resolve()
		urlTemplate.replace(/%#[12]/g, s => {
			promise = promise.then(async () => {
				if (task.data.state !== 'completed')
					throw abortError()
				if (hashes.has(s)) return
				const length = s.endsWith('2') ? 64 : 40
				hashes.set(s, await task.getChecksum(length, true))
			})
			return s
		})
		try { await promise } catch { continue }
		urls.push(urlTemplate.replace(/%s|%#[12]/g, s => {
			if (s === '%s')
				return encodeURIComponent(task.data.filename || '')
			else
				return hashes.get(s) || ''
		}))
	}
	for (const url of urls) void browser.tabs.create({ url })
}