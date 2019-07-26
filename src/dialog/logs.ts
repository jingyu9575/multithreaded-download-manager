import { applyI18n } from "../util/webext/i18n.js";
import { backgroundRemote } from "../common/common.js";
import { Timer } from "../util/promise.js";

applyI18n()

const tbody = document.getElementById('log-tbody')!
const tableContainer = document.getElementById('table-container')!

const id = Number(new URLSearchParams(location.search).get('id') || NaN)
if (Number.isInteger(id)) {
	const timer = new Timer(async () => {
		const items = await backgroundRemote.getTaskLog(id, tbody.childElementCount)
		if (!items) { timer.stop(); return }
		const scrollAtBottom = tableContainer.scrollTop ===
			tableContainer.scrollHeight - tableContainer.clientHeight

		for (const item of items) {
			const tr = document.createElement('tr')
			tr.classList.add(item.level)
			const date = item.date.toLocaleString(undefined, { hour12: false })
			tr.append(Object.assign(document.createElement('td'),
				{ className: 'date', textContent: date, title: date }))
			tr.append(Object.assign(document.createElement('td'),
				{ className: 'message', textContent: item.message, title: item.message }))
			tr.append(Object.assign(document.createElement('td'),
				{ className: 'line', textContent: item.line, title: item.line }))
			tbody.append(tr)
		}

		if (scrollAtBottom) tableContainer.scrollTop =
			tableContainer.scrollHeight - tableContainer.clientHeight
	}, 1000)
	timer.start()
	timer.onTimer()
}

const rawDataButton = document.getElementById('raw-data') as HTMLInputElement
let blobURL = ''
rawDataButton.addEventListener('click', async () => {
	const items = await backgroundRemote.getTaskLog(id, 0)
	if (!items) { rawDataButton.disabled = true; return }
	if (blobURL) URL.revokeObjectURL(blobURL)
	blobURL = URL.createObjectURL(new File([JSON.stringify(items, undefined, '\t')],
		`log.json`, { type: 'application/json' }))
	location.href = blobURL
})