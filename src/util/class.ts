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
