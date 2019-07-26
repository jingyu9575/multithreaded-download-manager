export function registerRemoteHandler(handler: object,
	remoteProxyId = handler.constructor.name) {
	const listener = (message: any) => {
		if (!message || message.remoteProxyId !== remoteProxyId
			|| !(message.name in handler)) return undefined
		return (async () => (handler as any)[message.name](...message.args))() // Promise
	}
	browser.runtime.onMessage.addListener(listener)
	return { destroy() { browser.runtime.onMessage.removeListener(listener) } }
}

export function remoteProxy<T>(remoteProxyId: string) {
	return new Proxy({}, {
		get(_target, name) {
			return (...args: any[]) => browser.runtime.sendMessage({
				remoteProxyId, name, args
			}).catch(e => {
				if (typeof e === 'object' && e.name === 'Error' && e.message ===
					"Could not establish connection. Receiving end does not exist.")
					return undefined
				throw e
			})
		}
	}) as T
}
