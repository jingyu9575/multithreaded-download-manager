interface IDBMutableFile { }
interface LockedFile { }
interface DOMRequest { }

declare const IDBFiles: {
	getFileStorage(param: { name?: string, persistent?: boolean }):
		Promise<IDBFileStorage>
	waitForDOMRequest(req: IDBRequest, onsuccess: (result: any) => any): Promise<any>
}

interface IDBFileStorage {
	clear(): Promise<void>
	count(options?: IDBFileStorage.ListFilteringOptions): Promise<number>
	createMutableFile(fileName: string, fileType?: string):
		Promise<IDBPromisedMutableFile>
	get(fileName: string): Promise<Blob | File | IDBPromisedMutableFile | undefined>
	list(options?: IDBFileStorage.ListFilteringOptions): Promise<string[]>
	put(fileName: string,
		file: Blob | File | IDBPromisedMutableFile | IDBMutableFile): Promise<void>
	remove(fileName: string): Promise<void>
}

declare namespace IDBFileStorage {
	interface ListFilteringOptions {
		startsWith?: string
		endsWith?: string
		includes?: string
		filterFn?: (fileName: string) => boolean
	}
}

interface IDBPromisedFileHandle {
	active: boolean
	mode: "readonly" | "readwrite" | "writeonly"
	abort(): Promise<void>
	append(data: string | ArrayBuffer): Promise<void>
	close(): Promise<void>
	getMetadata(): Promise<IDBPromisedFileHandle.Metadata>
	queuedWrite(data: string | ArrayBuffer, location?: number): Promise<number>
	readAsArrayBuffer(size: number, location?: number): Promise<ArrayBuffer>
	readAsText(size: number, location?: number): Promise<string>
	truncate(location?: number): Promise<ArrayBuffer>
	waitForQueuedWrites(): Promise<number>
	write(data: string | ArrayBuffer, location?: number): Promise<number>
}

declare namespace IDBPromisedFileHandle {
	interface Metadata {
		size: number
		lastModified: Date
	}
}

interface IDBPromisedMutableFile {
	getFile(): Promise<File>
	open(mode: "readonly" | "readwrite"): IDBPromisedFileHandle
	persist(): Promise<void>
	persistAsFileSnapshot(snapshotName: string): Promise<File>
	runFileRequestGenerator(
		generatorFunction: (lockedFile: LockedFile) => IterableIterator<DOMRequest>,
		mode: "readonly" | "readwrite"): any
}