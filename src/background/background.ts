import './init.js'
import './multithreaded-task.js'
import './monitor.js'

import { isWebExtOOPDisabled } from './webext-oop.js';
import { registerRemoteHandler } from "../util/webext/remote.js";
import { MultithreadedTaskData, TaskData } from "../common/task-data.js";
import { Task } from "./task.js";
import { openPopupWindow, openOptions } from "./open-window.js";
import { SimpleMutableFile } from "../util/storage.js";
import { MultithreadedTask } from './multithreaded-task.js';
import { getCustomCSS } from '../common/get-custom-css.js';

export class BackgroundRemote {
	isWebExtOOPDisabled() { return isWebExtOOPDisabled }

	async openPopupWindow(url: string) { return openPopupWindow(url) }
	async openOptions() { return openOptions() }

	requestTaskSyncInit() { Task.syncInit(); Task.updateBadge() }

	async createTask(data: MultithreadedTaskData) {
		return (await Task.create(data)).id
	}

	callTaskMethod(id: number, method: 'start' | 'pause' | 'reset' | 'remove') {
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

	getCustomCSS() { return getCustomCSS() }
}
registerRemoteHandler(new BackgroundRemote)
