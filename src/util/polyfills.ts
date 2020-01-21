export { }

declare global {
	interface Blob {
		arrayBuffer(): Promise<ArrayBuffer>
	}
}

if (!Blob.prototype.arrayBuffer) {
	Blob.prototype.arrayBuffer = function () {
		return new Response(this).arrayBuffer()
	}
}