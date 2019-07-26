import { applyI18n } from "../util/webext/i18n.js";
import { SimpleStorage } from "../util/storage.js";

applyI18n()

void async function () {
	const storage = await SimpleStorage.create('etc')
	const textarea = document.getElementById('customCSS') as HTMLTextAreaElement
	textarea.value = String(await storage.get('customCSS') || '')

	const saveButton = document.getElementById('save') as HTMLButtonElement
	saveButton.disabled = true
	textarea.addEventListener('input', () => { saveButton.disabled = false })
	saveButton.addEventListener('click', () => {
		void storage.set('customCSS', textarea.value)
		saveButton.disabled = true
	})
	document.addEventListener('keydown', e => {
		if (e.ctrlKey && e.key === 's') {
			e.preventDefault()
			saveButton.click()
		}
	})
}()