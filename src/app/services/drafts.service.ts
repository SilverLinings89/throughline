import { Injectable, effect, inject, untracked } from '@angular/core';
import { parseEmbeddedData } from '../core/analysis/readings';
import { readDocument } from '../core/formats/formats';
import { isStoredHandle } from '../core/platform';
import { EMPTY_DOC_SETTINGS, type BlockMeta, type Bytes, type DocFormat, type DocSettings } from '../core/model';
import { DocumentStore } from './document.store';
import { EditorService, type EditorSnapshot } from './editor.service';
import { Notifier } from './notifier';
import { ReadingCache } from './reading-cache';

interface Draft {
	readonly v: 1;
	readonly name: string;
	readonly ext: string;
	readonly format: DocFormat;
	readonly snapshot: EditorSnapshot;
	readonly settings: DocSettings;
	readonly ignored: string[];
	readonly dismissed: string[];
	readonly at: number;
}

const FORMATS: readonly DocFormat[] = ['docx', 'odt', 'md', 'txt'];
const isDict = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isPairs = <T>(v: unknown, second: (x: unknown) => x is T): v is [string, T][] =>
	Array.isArray(v) && v.every(p => Array.isArray(p) && typeof p[0] === 'string' && second(p[1]));
const isMeta = (x: unknown): x is BlockMeta => isDict(x) && (x['fmt'] === 'docx' || x['fmt'] === 'odt') && typeof x['xml'] === 'string';

function parseDraft(raw: unknown): Draft | null {
	if (!isDict(raw) || raw['v'] !== 1 || !isDict(raw['snapshot'])) return null;
	const snap = raw['snapshot'];
	const format = FORMATS.find(f => f === raw['format']);
	if (!format || typeof snap['html'] !== 'string' || !isPairs(snap['meta'], isMeta) || !isPairs(snap['signatures'], (x): x is string => typeof x === 'string')) return null;
	const data = parseEmbeddedData({ app: 'Throughline', settings: raw['settings'], ignored: raw['ignored'], dismissed: raw['dismissed'] });
	return {
		v: 1, name: typeof raw['name'] === 'string' ? raw['name'] : '', ext: typeof raw['ext'] === 'string' ? raw['ext'] : format, format,
		snapshot: { html: snap['html'], meta: snap['meta'], signatures: snap['signatures'] },
		settings: data?.settings ?? EMPTY_DOC_SETTINGS, ignored: data?.ignored ?? [], dismissed: data?.dismissed ?? [],
		at: typeof raw['at'] === 'number' ? raw['at'] : Date.now(),
	};
}

/**
 * Crash recovery. While a document has unsaved changes, its state goes to IndexedDB every
 * five seconds; on the next start the app offers it back. The original package bytes are kept
 * too, so a restored .docx or .odt still saves with its tables, images and styles.
 */
@Injectable({ providedIn: 'root' })
export class DraftService {
	private readonly db = inject(ReadingCache).db;
	private readonly editor = inject(EditorService);
	private readonly docs = inject(DocumentStore);
	private readonly notifier = inject(Notifier);
	private changed = false;

	constructor() {
		effect(() => {
			this.editor.structure();
			this.docs.settings();
			if (untracked(() => this.docs.dirty())) this.changed = true;
		});
		setInterval(() => void this.save(), 5000);
	}

	async save(): Promise<void> {
		if (!this.changed || !this.docs.dirty()) return;
		const snapshot = this.editor.snapshot();
		if (!snapshot) return;
		this.changed = false;
		const f = this.docs.file();
		const draft: Draft = { v: 1, name: f.name, ext: f.ext, format: f.format, snapshot, settings: this.docs.settings(), ignored: [...this.docs.ignored()], dismissed: [...this.docs.dismissed()], at: Date.now() };
		await this.db.put('drafts', 'current', draft);
	}

	async forget(): Promise<void> { this.changed = false; await this.db.delete('drafts', 'current'); }

	/** Keeps the package the document came from, and its file handle where the browser allows it. */
	async rememberSource(bytes: Bytes | null, handle: FileSystemFileHandle | null): Promise<void> {
		if (bytes) await this.db.put('drafts', 'package', bytes); else await this.db.delete('drafts', 'package');
		if (handle) await this.db.put('drafts', 'handle', handle); else await this.db.delete('drafts', 'handle');
	}

	/** Document settings kept outside the file, for documents saved without embedded data. */
	async settingsFor(name: string): Promise<DocSettings | null> {
		return parseEmbeddedData({ app: 'Throughline', settings: await this.db.get('drafts', `settings:${name}`) })?.settings ?? null;
	}
	async storeSettings(name: string, s: DocSettings): Promise<void> { await this.db.put('drafts', `settings:${name}`, s); }

	/** Shows the restore banner when unsaved work is waiting. */
	async offer(): Promise<void> {
		const draft = parseDraft(await this.db.get('drafts', 'current'));
		if (!draft) return;
		const when = new Date(draft.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
		this.notifier.ask(`Unsaved work on ${draft.name || 'an untitled document'} from ${when} is still here.`, [
			{ label: 'Restore it', run: () => void this.restore(draft) },
			{ label: 'Discard it', run: () => void this.forget() },
		]);
	}

	private async restore(d: Draft): Promise<void> {
		let ctx = null;
		const pkg = await this.db.get('drafts', 'package');
		if ((d.format === 'docx' || d.format === 'odt') && pkg instanceof Uint8Array) {
			try { ctx = (await readDocument(`x.${d.format}`, new Uint8Array(pkg))).ctx; } catch { ctx = null; }
		}
		const handle = await this.db.get('drafts', 'handle');
		this.docs.reset({ name: d.name, ext: d.ext, format: d.format, handle: isStoredHandle(handle) ? handle : null, lastModified: 0 }, d.settings, ctx, d.ignored, d.dismissed);
		this.editor.restore(d.snapshot);
		this.docs.dirty.set(true);
		this.notifier.say('Restored. Save to keep it in the file.');
	}
}
