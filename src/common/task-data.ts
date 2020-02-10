import { NetworkOptions, StorageAPIOption } from "./settings.js";

export type DownloadState = 'downloading' | 'saving' | 'paused' |
	'completed' | 'failed' | 'queued'

export const DownloadState = {
	isProgressing(state: DownloadState) {
		return ['downloading', 'saving', 'queued'].includes(state)
	},
	canPause(state: DownloadState) {
		return ['downloading', 'queued'].includes(state)
	},
	canStart(state: DownloadState) {
		return ['paused', 'failed', 'queued'].includes(state)
	},
	areChunksFinished(state: DownloadState) {
		return ['saving', 'completed'].includes(state)
	},
	colors: {
		downloading: 'cornflowerblue',
		saving: 'cornflowerblue',
		failed: 'red',
		paused: 'goldenrod',
		completed: 'green',
		queued: 'cornflowerblue',
	}
}

export interface TaskProgressItem { currentSize: number, writtenSize: number }
export interface TaskProgressItems { [startPosition: number]: TaskProgressItem }

export interface TaskProgress {
	items: TaskProgressItems
	currentSize: number
	averageSpeed?: number
	currentThreads: number
	currentWarnings: number
	reset?: boolean
}

export interface TaskData {
	type: string
	url: string
	filename?: string
	substituteFilename?: string
	filenameTemplate: string
	referrer?: string
	state: DownloadState
	error?: string | null
	totalSize?: number
	fileAccessId?: number | null
	canResume?: boolean
	creationDate: Date
	completedDate?: Date
	inum: number
	text?: string
	checksum?: string
}

export const TaskData = {
	isEditable(data: TaskData) {
		return data.type === 'MultithreadedTask' &&
			!DownloadState.areChunksFinished(data.state)
	},
	default(): TaskData {
		return {
			type: 'MultithreadedTask', state: 'downloading',
			creationDate: new Date(), inum: 1,
			url: 'about:blank', filenameTemplate: '',
		}
	}
}

export interface TaskSyncBootstrapItem {
	id: number
	data: TaskData
	progress: TaskProgress
}

export interface MultithreadedTaskData extends TaskData, NetworkOptions {
	storageAPI?: StorageAPIOption
}

export interface TaskActionDetail {
	primary?: boolean
	shift?: keyof I18nMessages
	filterStates?: DownloadState[]
	filterCanResume?: boolean
}
type TaskActions = [keyof I18nMessages | /*separator*/number, TaskActionDetail][]

export const taskActions: TaskActions = [
	['start', { primary: true, filterStates: ['paused', 'failed'] }],
	['pause', {
		primary: true,
		filterStates: ['downloading', 'queued'], filterCanResume: true
	}],
	['stop', {
		primary: true,
		filterStates: ['downloading', 'queued'], filterCanResume: false
	}],
	['openFile', {
		primary: true, shift: 'openContainingFolder', filterStates: ['completed']
	}],
	['openContainingFolder', {}],
	[101, {}],
	['copyLink', { shift: 'openReferrer' }],
	['openReferrer', {}],
	['viewLogs', {}],
	[102, {}],
	['edit', {}],
	['reset', {
		filterStates: ['downloading', 'paused', 'completed', 'failed', 'queued']
	}],
	['remove', { shift: 'deleteFile' }],
	['deleteFile', { filterStates: ['completed'] }],
]

export const taskActionPrefix = 'task-action-'
export const filenameSearchPrefix = 'filename-search-'