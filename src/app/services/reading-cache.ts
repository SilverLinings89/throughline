import { Injectable, signal } from '@angular/core';
import { kindOfKey, parseReading, type DocReading, type ParaReading, type Reading, type SectionReading } from '../core/analysis/readings';
import { KeyValueDb } from '../core/storage/idb';

/**
 * Readings by key, in memory and in IndexedDB. Keys are hashes of the text they describe,
 * so a reading is reused for identical text in any document and never goes stale.
 * Reading `get` inside a computed signal makes it recompute when new readings arrive.
 */
@Injectable({ providedIn: 'root' })
export class ReadingCache {
	readonly db = new KeyValueDb();
	/** Increments whenever a reading is added or the cache is cleared. */
	readonly version = signal(0);
	private readonly mem = new Map<string, Reading>();
	private readonly checked = new Set<string>();
	private pendingWrites = new Map<string, Reading>();
	private writeTimer: ReturnType<typeof setTimeout> | undefined;

	/** Last section reading per section title hash, for sections edited since. */
	readonly bySectionTitle = new Map<string, string>();
	/** Last paragraph reading per block id, for paragraphs edited since. */
	readonly byBlock = new Map<string, string>();
	lastDocKey: string | null = null;

	get(key: string | null): Reading | undefined {
		this.version();
		return key ? this.mem.get(key) : undefined;
	}
	para(key: string | null): ParaReading | null { const r = this.get(key); return r?.kind === 'para' ? r : null; }
	section(key: string | null): SectionReading | null { const r = this.get(key); return r?.kind === 'section' ? r : null; }
	doc(key: string | null): DocReading | null { const r = this.get(key); return r?.kind === 'doc' ? r : null; }
	has(key: string): boolean { return this.mem.has(key); }

	/** Stores a reading. `persist` writes it to IndexedDB in the background. */
	put(key: string, reading: Reading, persist = true): void {
		this.mem.set(key, reading);
		this.version.update(v => v + 1);
		if (!persist) return;
		this.pendingWrites.set(key, reading);
		clearTimeout(this.writeTimer);
		this.writeTimer = setTimeout(() => {
			const entries = [...this.pendingWrites];
			this.pendingWrites = new Map();
			void this.db.putMany('cache', entries);
		}, 1500);
	}

	/** Loads readings for `keys` from IndexedDB once. Resolves to the number found. */
	async lookup(keys: readonly string[]): Promise<number> {
		const want = keys.filter(k => !this.mem.has(k) && !this.checked.has(k));
		if (!want.length) return 0;
		for (const k of want) this.checked.add(k);
		const found = await this.db.getMany('cache', want);
		let n = 0;
		for (const [k, v] of found) {
			const kind = kindOfKey(k);
			const r = kind ? parseReading(kind, v) : null;
			if (r) { this.mem.set(k, r); n++; }
		}
		if (n) this.version.update(v => v + 1);
		return n;
	}

	/** Drops one reading from memory so it is requested again. */
	forget(key: string): void { if (this.mem.delete(key)) this.version.update(v => v + 1); }

	isChecked(key: string): boolean { return this.checked.has(key); }

	/** Forgets per-document fallbacks when another document opens. Readings stay. */
	resetDocument(): void {
		this.bySectionTitle.clear();
		this.byBlock.clear();
		this.lastDocKey = null;
		this.checked.clear();
	}

	async clearAll(): Promise<void> {
		this.mem.clear();
		this.resetDocument();
		await this.db.clear('cache');
		this.version.update(v => v + 1);
	}
}
