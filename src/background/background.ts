import './init.js'
import './multithreaded-task.js'
import './monitor.js'

import { registerRemoteHandler } from "../util/webext/remote.js";
import { MultithreadedTaskData, TaskData } from "../common/task-data.js";
import { Task } from "./task.js";
import { openPopupWindow, openOptions } from "./open-window.js";
import { SimpleMutableFile } from "../util/storage.js";
import { MultithreadedTask } from './multithreaded-task.js';

let isWebExtOOPEnabledResult: boolean | undefined

export class BackgroundRemote {
	isWebExtOOPEnabled() { // Detects bug 1272869 to check if webext-oop is enabled.
		// TODO Android support: verify this check; see if other workarounds are needed
		if (isWebExtOOPEnabledResult !== undefined) return isWebExtOOPEnabledResult
		const element = document.getElementById('webext-oop-check') as HTMLTextAreaElement
		let result = false
		const handler = (event: ClipboardEvent) => {
			if (event.target !== element) return
			result = true
			event.preventDefault() // prevent the actual copy action
		}
		document.addEventListener('copy', handler)
		element.select()
		document.execCommand("copy") // requires clipboardWrite permission
		// W3C Clipboard: the copy event is fired synchronously
		document.removeEventListener('copy', handler)
		return (isWebExtOOPEnabledResult = result)
	}

	async openPopupWindow(url: string) { return openPopupWindow(url) }
	async openOptions() { return openOptions() }

	requestTaskSyncInit() { Task.syncInit(); Task.updateBadge() }

	async createTask(data: MultithreadedTaskData) {
		return (await Task.create(data)).id
	}

	callTaskMethod(id: number, method: 'start' | 'pause' | 'remove') {
		const task = Task.get(id)
		if (task) task[method]()
	}

	async isStorageAvailable() {
		try {
			await Task.initialization
			return SimpleMutableFile.isAvailable
		} catch { return false }
	}

	async isConnectionAPIAvailable() {
		return MultithreadedTask.getPreferredConnectionClass().isAvailable
	}

	async getFallbackEncoding() { return document.characterSet }

	async getTaskLog(id: number, skip: number) {
		const task = Task.get(id)
		return task && task.logger.get(skip)
	}

	async getTaskData(id: number) {
		const task = Task.get(id)
		return task && task.data
	}

	async editTaskData(id: number, data: Partial<TaskData>) {
		const task = Task.get(id)
		if (task) task.editData(data)
	}

	playAllCompletedSound() { Task.playAllCompletedSound() }
}
registerRemoteHandler(new BackgroundRemote)
