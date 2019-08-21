export function mergeInitData<B extends new (...args: any[]) => object, D>(
	Base: B, initData: D) {
	class C extends Base {
		constructor(...args: any[]) {
			super(...args)
			Object.assign(this, initData)
		}
	}
	return C as B & (new (...args: any[]) => D)
}

export function mapInsert<K, V>(
	map: Map<K, V> | (K extends object ? WeakMap<K, V> : never), key: K, fn: () => V) {
	if (map.has(key)) return map.get(key)!
	const value = fn()
	map.set(key, value)
	return value
}

type TypedArray = Int8Array | Int16Array | Int32Array |
	Uint8Array | Uint16Array | Uint32Array | Uint8ClampedArray |
	Float32Array | Float64Array

export function typedArrayToBuffer(ta: TypedArray) {
	return (ta.byteOffset === 0 && ta.byteLength === ta.buffer.byteLength ?
		ta : ta.slice()).buffer
}

// may share buffers
export function concatTypedArray<T extends TypedArray>(list: T[]) {
	if (!list.length) return undefined
	if (list.length === 1) return list[0]
	let length = 0
	for (const a of list) length += a.length
	const result: T = new (list[0].constructor as any)(length)

	let offset = 0
	for (const a of list) {
		result.set(a, offset)
		offset += a.length
	}
	return result
}