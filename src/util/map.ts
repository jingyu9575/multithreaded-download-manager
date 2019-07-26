export function mapInsert<K, V>(
	map: Map<K, V> | (K extends object ? WeakMap<K, V> : never), key: K, fn: () => V) {
	if (map.has(key)) return map.get(key)!
	const value = fn()
	map.set(key, value)
	return value
}

export class BiMap<K, V>  {
	private readonly map: Map<K, V>
	private readonly reverse: Map<V, K>

	constructor(entries?: ReadonlyArray<[K, V]> | null) {
		this.map = new Map(entries)
		this.reverse = new Map(!entries ? entries :
			entries.map(([k, v]) => [v, k] as [V, K]))
	}

	clear() {
		this.map.clear()
		this.reverse.clear()
	}

	delete(key: K) {
		if (!this.map.has(key)) return false
		this.reverse.delete(this.map.get(key)!)
		this.map.delete(key)
		return true
	}
	deleteValue(value: V) {
		if (!this.reverse.has(value)) return false
		this.map.delete(this.reverse.get(value)!)
		this.reverse.delete(value)
		return true
	}

	forEach(callbackfn: (value: V, key: K, map: Map<K, V>) => void, thisArg?: any) {
		return this.map.forEach(callbackfn, thisArg)
	}

	get(key: K) { return this.map.get(key) }
	getKey(value: V) { return this.reverse.get(value) }

	has(key: K) { return this.map.has(key) }
	hasValue(value: V) { return this.reverse.has(value) }

	set(key: K, value: V) {
		this.delete(key)
		this.deleteValue(value)
		this.map.set(key, value)
		this.reverse.set(value, key)
	}

	get size() { return this.map.size }

	[Symbol.iterator]() { return this.map[Symbol.iterator]() }
	entries() { return this.map.entries() }
	keys() { return this.map.keys() }
	values() { return this.map.values() }
}