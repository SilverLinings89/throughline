/**
 * A small key-value wrapper around IndexedDB with two stores:
 * `cache` (readings by key) and `drafts` (crash recovery). Every call resolves, never rejects:
 * storage is a convenience, so a failure must not break editing.
 */
export type StoreName = 'cache' | 'drafts';

export class KeyValueDb {
	private opening: Promise<IDBDatabase | null> | null = null;

	constructor(private readonly name = 'throughline') {}

	private open(): Promise<IDBDatabase | null> {
		this.opening ??= new Promise(resolve => {
			try {
				const rq = indexedDB.open(this.name, 1);
				rq.onupgradeneeded = () => {
					for (const s of ['cache', 'drafts']) if (!rq.result.objectStoreNames.contains(s)) rq.result.createObjectStore(s);
				};
				rq.onsuccess = () => resolve(rq.result);
				rq.onerror = () => resolve(null);
				rq.onblocked = () => resolve(null);
			} catch { resolve(null); }
		});
		return this.opening;
	}

	async get(store: StoreName, key: string): Promise<unknown> {
		const db = await this.open();
		if (!db) return undefined;
		return new Promise(resolve => {
			try {
				const rq = db.transaction(store).objectStore(store).get(key);
				rq.onsuccess = () => resolve(rq.result);
				rq.onerror = () => resolve(undefined);
			} catch { resolve(undefined); }
		});
	}

	async getMany(store: StoreName, keys: readonly string[]): Promise<Map<string, unknown>> {
		const out = new Map<string, unknown>();
		const db = await this.open();
		if (!db || !keys.length) return out;
		return new Promise(resolve => {
			try {
				const tx = db.transaction(store);
				const os = tx.objectStore(store);
				for (const k of keys) {
					const rq = os.get(k);
					rq.onsuccess = () => { if (rq.result !== undefined) out.set(k, rq.result); };
				}
				tx.oncomplete = () => resolve(out);
				tx.onerror = () => resolve(out);
				tx.onabort = () => resolve(out);
			} catch { resolve(out); }
		});
	}

	async putMany(store: StoreName, entries: readonly (readonly [string, unknown])[]): Promise<boolean> {
		const db = await this.open();
		if (!db || !entries.length) return false;
		return new Promise(resolve => {
			try {
				const tx = db.transaction(store, 'readwrite');
				const os = tx.objectStore(store);
				for (const [k, v] of entries) os.put(v, k);
				tx.oncomplete = () => resolve(true);
				tx.onerror = () => resolve(false);
				tx.onabort = () => resolve(false);
			} catch { resolve(false); }
		});
	}

	put(store: StoreName, key: string, value: unknown): Promise<boolean> {
		return this.putMany(store, [[key, value]]);
	}

	async delete(store: StoreName, key: string): Promise<void> {
		const db = await this.open();
		if (!db) return;
		await new Promise<void>(resolve => {
			try {
				const tx = db.transaction(store, 'readwrite');
				tx.objectStore(store).delete(key);
				tx.oncomplete = () => resolve();
				tx.onerror = () => resolve();
			} catch { resolve(); }
		});
	}

	async clear(store: StoreName): Promise<void> {
		const db = await this.open();
		if (!db) return;
		await new Promise<void>(resolve => {
			try {
				const tx = db.transaction(store, 'readwrite');
				tx.objectStore(store).clear();
				tx.oncomplete = () => resolve();
				tx.onerror = () => resolve();
			} catch { resolve(); }
		});
	}
}
