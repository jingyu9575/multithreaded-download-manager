applyI18n()

backgroundRemote.getFallbackEncoding().then(value => {
	(document.querySelector('input[data-key="legacyFilenameEncoding"]'
	) as HTMLInputElement).placeholder = value
})

for (const input of document.querySelectorAll(
	'[data-key]') as NodeListOf<HTMLInputElement | HTMLSelectElement>) {
	const key = input.dataset.key!
	Settings.get(key as any).then(value => {
		if (input.type === 'checkbox')
			(input as HTMLInputElement).checked = value
		else
			input.value = '' + value
	})
	input.addEventListener('change', () => {
		if (!input.checkValidity()) return
		let value: any
		if (input.type === 'number')
			value = Number(input.value)
		else if (input.type === 'checkbox')
			value = (input as HTMLInputElement).checked
		else value = input.value
		void Settings.set({ [key]: value })
	})
}

Settings.get('showOptionsInDedicatedTab').then(async v => {
	if (!v) return
	const tab = await browser.tabs.getCurrent()
	if (!tab || !tab.url ||
		tab.url.toLowerCase().startsWith(location.origin.toLowerCase())) return
	await browser.tabs.create({ url: location.href })
	location.href = 'about:blank'
})