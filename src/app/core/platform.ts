/**
 * Typed access to browser APIs that TypeScript's DOM library does not declare yet:
 * the File System Access pickers and permissions, and the PWA launch queue.
 * Every accessor checks that the API exists before returning it.
 */
export interface PickerType { readonly description: string; readonly accept: Record<string, string[]> }
type OpenPicker = (o: { types: PickerType[]; excludeAcceptAllOption?: boolean }) => Promise<FileSystemFileHandle[]>;
type SavePicker = (o: { suggestedName: string; types: PickerType[] }) => Promise<FileSystemFileHandle>;
interface LaunchParams { readonly files: readonly FileSystemHandle[] }
interface LaunchQueue { setConsumer(consumer: (p: LaunchParams) => void): void }
type PermissionMode = { mode: 'read' | 'readwrite' };
interface PermissionMethods {
	queryPermission?: (m: PermissionMode) => Promise<PermissionState>;
	requestPermission?: (m: PermissionMode) => Promise<PermissionState>;
}

function method<T>(owner: object, name: string, check: (v: unknown) => v is T): T | null {
	const v: unknown = Reflect.get(owner, name);
	return check(v) ? v : null;
}
const isFunction = (v: unknown): v is (...args: never[]) => unknown => typeof v === 'function';

export function openPicker(): OpenPicker | null {
	const fn = method(window, 'showOpenFilePicker', isFunction);
	return fn ? (o => Reflect.apply(fn, window, [o])) : null;
}

export function savePicker(): SavePicker | null {
	const fn = method(window, 'showSaveFilePicker', isFunction);
	return fn ? (o => Reflect.apply(fn, window, [o])) : null;
}

export function launchQueue(): LaunchQueue | null {
	const q: unknown = Reflect.get(window, 'launchQueue');
	return typeof q === 'object' && q !== null && isFunction(Reflect.get(q, 'setConsumer')) ? { setConsumer: c => Reflect.apply(Reflect.get(q, 'setConsumer'), q, [c]) } : null;
}

/** Asks for write permission when needed. Resolves to false when the user declines. */
export async function canWrite(handle: FileSystemFileHandle): Promise<boolean> {
	const h: FileSystemFileHandle & PermissionMethods = handle;
	if (!h.queryPermission) return true;
	if ((await h.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
	return (await h.requestPermission?.({ mode: 'readwrite' })) === 'granted';
}

export function isFileHandle(h: FileSystemHandle | null | undefined): h is FileSystemFileHandle {
	return !!h && h.kind === 'file';
}

/** The writable handle behind a dropped file, where the browser offers one. */
export async function droppedFileHandle(item: DataTransferItem): Promise<FileSystemFileHandle | null> {
	const get = method(item, 'getAsFileSystemHandle', isFunction);
	if (!get) return null;
	try {
		const h: unknown = await Reflect.apply(get, item, []);
		return isStoredHandle(h) ? h : null;
	} catch { return null; }
}

/** True for a file handle, including one read back from IndexedDB. */
export function isStoredHandle(v: unknown): v is FileSystemFileHandle {
	return typeof FileSystemFileHandle !== 'undefined' && v instanceof FileSystemFileHandle;
}
