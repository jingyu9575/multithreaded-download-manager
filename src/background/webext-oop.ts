// Detects bug 1272869 to check if webext-oop is enabled.
// TODO Android support: verify this check
export const isWebExtOOPDisabled = function () {
	const element = document.getElementById('webext-oop-check') as HTMLTextAreaElement
	let enabled = false
	const handler = (event: ClipboardEvent) => {
		if (event.target !== element) return
		enabled = true
		event.preventDefault() // prevent the actual copy action
	}
	document.addEventListener('copy', handler)
	element.select()
	document.execCommand("copy") // requires clipboardWrite permission
	// W3C Clipboard: the copy event is fired synchronously
	document.removeEventListener('copy', handler)
	return !enabled
}()