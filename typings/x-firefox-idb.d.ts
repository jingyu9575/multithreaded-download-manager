interface IDBObjectStore {
	getAll(query?: IDBKeyRange | IDBValidKey, count?: number): IDBRequest
	getAllKeys(query?: IDBKeyRange | IDBValidKey, count?: number): IDBRequest
}

interface IDBIndex {
	getAll(query?: IDBKeyRange | IDBValidKey, count?: number): IDBRequest
}

interface IDBDatabase {
	createMutableFile(name: string, type: string): IDBRequest
}

interface IDBMutableFile {
	readonly name: string
	readonly type: string

	open(mode: "readonly" | "readwrite"): IDBFileHandle
	getFile(): IDBRequest
}

interface IDBFileHandle {
	mutableFile: IDBMutableFile
	location: number
	active: boolean

	write(data: string | ArrayBuffer): IDBRequest
	truncate(start?: number): IDBRequest
	readAsArrayBuffer(size: number): IDBRequest
}