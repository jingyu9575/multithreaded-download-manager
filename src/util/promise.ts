export class Deferred<T> {
	promise: Promise<T>
	resolve!: (value?: T | PromiseLike<T>) => void
	reject!: (reason?: any) => void

	constructor() {
		this.promise = new Promise((resolve, reject) => {
			this.reject = reject
			this.resolve = resolve
		})
	}
}

export class CriticalSection {
	private promise = Promise.resolve()

	sync<T>(fn: () => T | PromiseLike<T>) { // fair, non-recursive
		const result = this.promise.then(fn)
		this.promise = result.then(() => { }, () => { })
		return result
	}
}

export class Timer {
	private id?: number

	constructor(public onTimer: () => any, public defaultInterval = 0,
		public allowConcurrent = false) { }

	start(interval = this.defaultInterval) {
		this.stop()
		const id: number = setInterval(() => {
			if (this.id === id) this.dispatch()
		}, interval)
		this.id = id
	}

	startOnce(interval = this.defaultInterval) {
		this.stop()
		const id: number = setTimeout(() => {
			if (this.id !== id) return
			this.id = undefined
			this.dispatch()
		}, interval)
		this.id = id
	}

	stop() {
		if (this.id === undefined) return
		clearInterval(this.id) // clearTimeout, clearInterval are interchangeable
		this.id = undefined
	}

	get isStarted() { return this.id !== undefined }

	private concurrentCount = 0

	private async dispatch() {
		if (!this.allowConcurrent && this.concurrentCount) return
		this.concurrentCount++
		try { await this.onTimer() } finally { this.concurrentCount-- }
	}
}