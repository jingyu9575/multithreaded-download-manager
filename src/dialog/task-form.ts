import { MultithreadedTaskData, TaskData, DownloadState } from "../common/task-data.js";
import { backgroundRemote, closeWindow, movePlatformSubmitButton } from "../common/common.js";
import {
	remoteSettings, NetworkOptions, NETWORK_OPTIONS_KEYS, Settings
} from "../common/settings.js";

export class TaskFormElement extends HTMLFormElement {
	private addingPaused = 0

	init() {
		const networkOptions = this.querySelector(
			'.network-options') as HTMLDetailsElement
		const collapsedKey = `networkOptionsCollapsed.${location.pathname}`
		networkOptions.open = !Number(localStorage.getItem(collapsedKey))
		networkOptions.addEventListener('toggle', () => {
			localStorage.setItem(collapsedKey, `${Number(!networkOptions.open)}`)
		})

		const submitButton = this.querySelector('.submit') as HTMLButtonElement
		const addPausedButton = this.querySelector('.add-paused') as HTMLButtonElement
		void movePlatformSubmitButton(addPausedButton, submitButton, submitButton)

		addPausedButton.addEventListener('click', () => {
			try {
				this.addingPaused++
				submitButton.click()
			} finally { this.addingPaused-- }
		})

		remoteSettings.get('showAddPaused').then(v => addPausedButton.hidden = !v)

		this.addEventListener('submit', event => {
			event.preventDefault()
			const dataList = this.getDataList()
			if (!dataList.length) return

			const formObj: Partial<MultithreadedTaskData> = {}
			for (const input of this.querySelectorAll(
				'[data-key]') as NodeListOf<HTMLInputElement>)
				if (!input.disabled)
					(formObj as any)[input.dataset.key!] = input.value

			let ft = (formObj.filenameTemplate || '').trim()
			if (!ft) ft = this.getDefaultFilenameTemplate()
			if (dataList.length > 1 && ft && !ft.match(/\*[\w.]+\*/) &&
				!(ft.endsWith('/') || ft.endsWith('\\')))
				ft += '/'
			formObj.filenameTemplate = ft

			if (this.addingPaused) formObj.state = 'paused'

			this.submitData(dataList, formObj)
			this.doAfterSubmitting()
			this.saveNetworkOptions()
			closeWindow()
		})

		this.querySelector('.cancel')!.addEventListener('click', closeWindow)

		this.querySelector('.copy-address')!.addEventListener('click', async () => {
			const dataList = this.getDataList()
			if (!dataList.length) return

			const crlf = (await browser.runtime.getPlatformInfo()).os === 'win'
				? '\r\n' : '\n'
			await navigator.clipboard!.writeText(
				dataList.map(v => v.url).join(crlf) + (dataList.length > 1 ? crlf : ''))
		})

		let urlInputEventFlag = false
		this.querySelector('[data-key="url"]')!.addEventListener('input', () => {
			if (urlInputEventFlag) return
			urlInputEventFlag = true
			this.querySelector('.file-size-span')!.classList.add('obsolete')
		})

		const checksumInput = this.querySelector(
			'[data-key="checksum"]') as HTMLInputElement
		checksumInput.addEventListener('change', () => {
			checksumInput.value = checksumInput.value.replace(/\s/g, '')
		})
	}

	private willSaveNetworkOptions = false // only if loaded from default

	async loadDefaultNetworkOptions() {
		const obj = await remoteSettings.load(NETWORK_OPTIONS_KEYS)
		for (const input of this.querySelectorAll(
			'.network-options [data-key]') as NodeListOf<HTMLInputElement>) {
			const key = input.dataset.key!
			input.value = obj[key as keyof NetworkOptions] + ''
		}
		if (await remoteSettings.get('rememberLastNetworkOptions'))
			this.willSaveNetworkOptions = true
	}

	private saveNetworkOptions() {
		if (!this.willSaveNetworkOptions) return
		const obj: Partial<Settings> = {}
		for (const input of this.querySelectorAll(
			'.network-options [data-key]') as NodeListOf<HTMLInputElement>) {
			const key = input.dataset.key!
			Object.assign(obj, { [key]: input.value ? Number(input.value) : '' })
		}
		void remoteSettings.set(obj)
	}

	loadFromTaskData(data: TaskData) {
		for (const input of this.querySelectorAll(
			'[data-key]') as NodeListOf<HTMLInputElement>) {
			const key = input.dataset.key! as keyof TaskData
			if (data[key] === undefined) continue
			input.value = data[key] + ''
		}
	}

	getDataList = (): Partial<TaskData>[] => [{}]

	getDefaultFilenameTemplate = () => '' // *text* for convert-url-provider

	submitData = (dataList: Partial<TaskData>[], formObj: Partial<TaskData>) => {
		let inum = 1
		const creationDate = new Date()
		for (const data of dataList) {
			void backgroundRemote.createTask({
				type: 'MultithreadedTask' as const,
				state: 'downloading',
				creationDate,
				inum: inum++,
				...data, ...formObj,
			} as MultithreadedTaskData)
		}
	}

	doAfterSubmitting = () => { }
}
customElements.define('task-form', TaskFormElement, { extends: 'form' })