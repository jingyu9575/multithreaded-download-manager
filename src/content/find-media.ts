(function () {
	type TargetElement = HTMLImageElement | HTMLMediaElement |
		HTMLObjectElement | HTMLEmbedElement
	const urlSet = new Set<string>()
	return [
		...document.querySelectorAll<TargetElement>('img,audio,video,object,embed')
	].map(v => {
		try {
			const src = 'currentSrc' in v && v.currentSrc ||
				'src' in v && v.src ||
				'data' in v && v.data || ''
			const result: Partial<import('../common/task-data.js').TaskData> = {
				url: Object.assign(new URL(src), { hash: '' }).href,
				text: v.getAttribute('alt') || v.getAttribute('aria-label') ||
					v.title || (v.textContent || '').trim() || undefined,
			}
			return result
		} catch { return { url: undefined } }
	}).filter(v => {
		if (!v.url || urlSet.has(v.url)) return false
		urlSet.add(v.url)
		return true
	})
})()