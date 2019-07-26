export class ExtendableError extends Error {
	constructor(message?: string) {
		super(message)
		this.name = new.target.name
	}
}

export class AssertionError extends ExtendableError {
	constructor(message = 'assertion failed') { super(message) }
}

export function assert(condition: any, message?: string) {
	if (!condition) throw new AssertionError(message)
}

export function unreachable(): never {
	throw assert(false, "unreachable() called")
}

export function abortError() {
	return new DOMException("The operation was aborted. ", "AbortError")
}
export function readOnlyError() {
	return new DOMException(
		"A mutation operation was attempted in a READ_ONLY transaction.",
		"ReadOnlyError")
}

export function isError(o: any): o is Error {
	return o && typeof o.name === 'string' && typeof o.message === 'string' &&
		(o.stack === undefined || typeof o.stack === 'string')
}

export function isAbortError(error?: Error) {
	return error && error.constructor.name === 'DOMException' &&
		error.name === 'AbortError'
}

export class ReportedError extends ExtendableError {
	constructor(message: string, readonly detail?: string | number | Error) {
		super(message)
	}

	static convert(error: Error, defaultMessage: string) {
		if (error.name === this.name) return error as ReportedError
		return new this(defaultMessage, error)
	}

	get fullMessage() {
		const msg2 = isError(this.detail) ? this.detail.message : this.detail
		return this.detail === undefined ? this.message : `${this.message}: ${msg2}`
	}
}