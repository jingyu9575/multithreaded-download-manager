const immediateMap = new Map<number, () => unknown>()
let nextId = 1
const { port1, port2 } = new MessageChannel()

port1.onmessage = event => {
	const fn = immediateMap.get(event.data)
	if (!fn) return
	immediateMap.delete(event.data)
	try { fn() } catch (error) { console.error(error) }
}

export function setImmediate(fn: () => unknown) {
	const id = nextId++
	immediateMap.set(id, fn)
	port2.postMessage(id)
	return id
}

export function clearImmediate(id: number) {
	immediateMap.delete(id)
}