applyI18n()

void async function () {
	const storage = new SimpleStorage({ databaseName: 'etc' })
	const textarea = document.getElementById('customCSS') as HTMLTextAreaElement
	textarea.value = String(await storage.get('customCSS') || '')

	document.getElementById('save')!.addEventListener('click',
		() => storage.set('customCSS', textarea.value))
}()