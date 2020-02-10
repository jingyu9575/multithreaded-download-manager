import { filenameSearchPrefix } from "../common/task-data.js"
import { M } from "../util/webext/i18n.js";
import { remoteProxy } from "../util/webext/remote.js";

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
	void remoteProxy<import('../panel/panel').TaskSyncRemote>(
		'TaskSyncRemote').reloadFilenameSearch()
}