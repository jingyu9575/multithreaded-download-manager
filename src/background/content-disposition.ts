import { S } from "./settings.js";

function getLegacyFilenameEncoding() {
	return S.legacyFilenameEncoding || document.characterSet || 'UTF-8'
}

function parseRFC5987(value: string) {
	try {
		const parts = value.split('\'')
		if (parts.length !== 3) return undefined
		if (['utf-8', 'utf8'].includes(parts[0].toLowerCase()))
			return decodeURIComponent(parts[2])
		const arr = (parts[2].match(/%[0-9a-fA-F]{2}|./g) || [])
			.map(v => v.length === 3 ? parseInt(v.slice(1), 16) : v.charCodeAt(0))
			.filter(v => v <= 255)
		return (new TextDecoder(parts[0])).decode(Uint8Array.from(arr))
	} catch { return undefined }
}

export function parseURLEncodedFilename(s: string) {
	if (S.legacyFilenameDetectURLEncoded) {
		try {
			const decoded = decodeURIComponent(s)
			if (decoded !== s) return decoded
		} catch { }
	}
	if (S.legacyFilenameDetectNonStandardURLEncoded) {
		try {
			const seq = unescape(s)
			if (seq !== s) return decodeISO8859_1(seq);
		} catch { }
	}
	return s
}

function decodeISO8859_1(seq: string) {
	const arr = [...seq].map(v => v.charCodeAt(0)).filter(v => v <= 255)
	const encoding = getLegacyFilenameEncoding()
	return new TextDecoder(encoding).decode(Uint8Array.from(arr))
}

function parseLegacyFilename(value: string) {
	if (S.legacyFilenameDetectUTF8) try {
		return decodeURIComponent(escape(value))
	} catch { }
	try {
		return decodeISO8859_1(value)
	} catch { return undefined }
}

export function parseContentDisposition(contentDisposition: string) {
	const regex = /^\s*filename(\*?)\s*=\s*("[^"]+"?|(?:[-\w]+'[- \w]+')?[^\s;]+)(;?)/i
	let filename = ''
	for (let match: string[] | null,
		s = contentDisposition.replace(/^\s*[-\w]+\s*(?:;|$)/, '');
		match = regex.exec(s); s = s.replace(regex, '')) {
		if (!filename || match[1]) {
			let value = match[2].trim()
			if (value.startsWith('"')) {
				value = value.slice(1)
				if (value.endsWith('"')) value = value.slice(0, -1)
			}
			filename = (match[1] ? parseRFC5987(value) :
				parseLegacyFilename(value)) || value
			if (match[1]) break // star
		}
		if (!match[3]) break // semicolon
	}
	return filename || undefined
}
