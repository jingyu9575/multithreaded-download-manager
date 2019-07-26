import { isError } from "../util/error.js";
import { logLevels, LogLevel } from "../common/settings.js";
import { S } from "./settings.js";

const logLevelMap = new Map(logLevels.map((v, i) => [v, i]))

interface LogItem {
	level: LogLevel
	message: string
	extra?: unknown
	date: Date
	line: string
	stack?: string[]
}

export class Logger {
	private readonly items: LogItem[] = []

	i(message: string, extra?: unknown) { this.logImpl('info', message, extra) }
	w(message: string, extra?: unknown) { this.logImpl('warning', message, extra) }
	e(message: string, extra?: unknown) { this.logImpl('error', message, extra) }

	private logImpl(level: LogLevel, message: string, extra?: unknown) {
		if (logLevelMap.get(level)! < logLevelMap.get(S.logLevel)!) return

		const stack = (new Error().stack || '').split('\n').slice(2)
		if (stack[stack.length - 1] === '') stack.pop()
		let line = (stack[0] || '').replace(/.*@/, '')
		if (line.startsWith(location.origin)) line = line.slice(location.origin.length)

		if (isError(extra)) {
			const { name, message, stack } = extra
			extra = { name, message, stack }
		} else if (extra !== undefined) {
			extra = JSON.parse(JSON.stringify(extra))
		}

		this.items.push({
			level, message, date: new Date(), line, extra,
			stack: level === 'warning' || level === 'error' ? stack : undefined
		})
	}

	get(skip: number) { return this.items.slice(skip) }
}