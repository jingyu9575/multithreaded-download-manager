(function () {
	type TargetElement = HTMLAnchorElement | HTMLAreaElement
	type TaskData = import('../common/task-data.js').TaskData
	type Result = Partial<TaskData & { isSelected: true }>

	const selection = window.getSelection()
	const links = [...document.querySelectorAll<TargetElement>('a, area')].map(v => {
		try {
			let text: string | undefined
			if (v.tagName === 'area') {
				text = (v as HTMLAreaElement).alt
			} else {
				text = (v.textContent || '').replace(/[\r\n]/, ' ').trim()
				if (!text && v.children.length === 1 &&
					['img', 'svg'].includes(v.children[0].tagName.toLowerCase())) {
					text = (v.children[0] as HTMLImageElement).alt
				}
			}

			const result: Result = {
				url: Object.assign(new URL(v.href), { hash: '' }).href,
				text: text || v.getAttribute('aria-label') || v.title || undefined,
				substituteFilename: v.download || undefined,
			}
			if (selection && selection.containsNode(v, true))
				result.isSelected = true
			return result
		} catch { return { url: undefined } }
	})

	const map = new Map<string, Result>()
	for (const v1 of links) {
		if (!v1.url) continue
		const v0 = map.get(v1.url)
		if (!v0 || v1.isSelected && !v0.isSelected) {
			map.delete(v1.url) // insert at the end
			map.set(v1.url, v1)
		}
	}
	return [...map.values()] // Map preserves key order
})()