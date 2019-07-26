interface IDBDatabase {
	createMutableFile(name: string, type: string): IDBRequest<IDBMutableFile>
}

interface IDBMutableFile {
	readonly name: string
	readonly type: string

	open(mode: "readonly" | "readwrite"): IDBFileHandle
	getFile(): IDBRequest<File>
}

interface IDBFileHandle {
	mutableFile: IDBMutableFile
	location: number
	active: boolean

	write(data: string | ArrayBuffer): IDBRequest<void>
	truncate(start?: number): IDBRequest<unknown>
	flush(): IDBRequest<void>
	abort(): IDBRequest<void>
	readAsArrayBuffer(size: number): IDBRequest<ArrayBuffer>
}
