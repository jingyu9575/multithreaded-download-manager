import { filenameSearchPrefix } from "../common/task-data.js"
import { M } from "../util/webext/i18n.js";
import { remoteProxy } from "../util/webext/remote.js";
import { taskSyncRemote, Task } from "./task.js";

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

export async function searchFilename(taskIds: number[], url: string) {
	for (const id of taskIds) {
		const task = Task.get(id)
		if (!task) continue
		void browser.tabs.create({
			url: url.replace(/%s|%#[12]/g, s => {
				if (s === '%s')
					return encodeURIComponent(
						task.data.filename || task.data.filenameTemplate)
				return ''
			})
		})
	}
}