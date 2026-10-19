import { Injectable, inject } from '@angular/core';
import { parseEmbeddedData } from '../core/analysis/readings';
import { blankContext, formatOf, readDocument, writeDocument, MIME, type LoadedDocument, type PackageContext } from '../core/formats/formats';
import { readMarkdown } from '../core/formats/markdown';
import { EMPTY_DOC_SETTINGS, type Bytes, type DocFormat } from '../core/model';
import { canWrite, openPicker, savePicker, type PickerType } from '../core/platform';
import { errorMessage, log } from '../core/util/log';
import { AnalysisService } from './analysis.service';
import { DocumentStore, NEW_FILE } from './document.store';
import { DraftService } from './drafts.service';
import { EditorService } from './editor.service';
import { Notifier } from './notifier';
import { SettingsStore } from './settings.store';
import { SAMPLE_MARKDOWN, SAMPLE_THREAD } from './sample';

const PICKER_TYPES: Record<DocFormat, PickerType> = {
	docx: { description: 'Word document', accept: { [MIME.docx]: ['.docx'] } },
	odt: { description: 'OpenDocument text', accept: { [MIME.odt]: ['.odt'] } },
	md: { description: 'Markdown', accept: { [MIME.md]: ['.md'] } },
	txt: { description: 'Plain text', accept: { [MIME.txt]: ['.txt'] } },
};
const OPEN_TYPES: PickerType[] = [{ description: 'Documents', accept: { [MIME.docx]: ['.docx'], [MIME.odt]: ['.odt'], [MIME.md]: ['.md', '.markdown'], [MIME.txt]: ['.txt'] } }];

/** Opening, saving and creating documents. */
@Injectable({ providedIn: 'root' })
export class FilesService {
	private readonly editor = inject(EditorService);
	private readonly docs = inject(DocumentStore);
	private readonly analysis = inject(AnalysisService);
	private readonly drafts = inject(DraftService);
	private readonly notifier = inject(Notifier);
	private readonly settings = inject(SettingsStore);

	/** Fallback for browsers without the file picker API; set by the app shell. */
	fileInput: HTMLInputElement | null = null;

	private confirmDiscard(): boolean {
		return !this.docs.dirty() || confirm('Discard the unsaved changes in this document?');
	}

	async pick(): Promise<void> {
		const picker = openPicker();
		if (picker) {
			try {
				const [handle] = await picker({ types: OPEN_TYPES });
				if (handle) await this.open(await handle.getFile(), handle);
				return;
			} catch (e) {
				if (e instanceof DOMException && e.name === 'AbortError') return;
				log.warn('open-picker-failed', { error: errorMessage(e) });
			}
		}
		this.fileInput?.click();
	}

	async open(file: File, handle: FileSystemFileHandle | null): Promise<void> {
		if (!this.confirmDiscard()) return;
		let doc: LoadedDocument;
		const bytes: Bytes = new Uint8Array(await file.arrayBuffer());
		try { doc = await readDocument(file.name, bytes); }
		catch (e) { this.notifier.say(errorMessage(e), 7000); return; }
		await this.drafts.forget();
		await this.drafts.rememberSource(doc.ctx ? bytes : null, handle);
		await this.show(doc, file.name, handle, file.lastModified);
	}

	/** Puts a read document into the editor. */
	async show(doc: LoadedDocument, name: string, handle: FileSystemFileHandle | null, lastModified: number): Promise<void> {
		const data = parseEmbeddedData(doc.data);
		const settings = data?.settings ?? (name ? await this.drafts.settingsFor(name) : null) ?? EMPTY_DOC_SETTINGS;
		const lookup = formatOf(name);
		this.docs.reset({ name, ext: lookup.ok ? lookup.ext : doc.format, format: doc.format, handle, lastModified }, settings, doc.ctx, data?.ignored, data?.dismissed);
		this.analysis.loadEmbedded(data);
		this.editor.load(doc.blocks);
		const first = this.editor.structure().blocks.find(b => b.type !== 'opaque');
		if (first) this.editor.jumpTo(first.bid);
		const kept = doc.blocks.filter(b => b.type === 'opaque').length;
		if (name) this.notifier.say(`Opened ${name}.${kept ? ` ${kept} table${kept > 1 ? 's, images or other items are' : ', image or other item is'} kept as is.` : ''}`);
	}

	newDocument(): void {
		if (!this.confirmDiscard()) return;
		void this.drafts.forget();
		void this.drafts.rememberSource(null, null);
		this.docs.reset(NEW_FILE, EMPTY_DOC_SETTINGS, null);
		this.analysis.loadEmbedded(null);
		this.editor.load([]);
		this.editor.refocus();
	}

	loadSample(): void {
		if (!this.confirmDiscard()) return;
		void this.show({ format: 'docx', blocks: readMarkdown(SAMPLE_MARKDOWN), ctx: null, data: null }, '', null, 0).then(() => {
			this.docs.updateSettings({ thread: SAMPLE_THREAD });
			this.docs.dirty.set(false);
			this.editor.reindex();
			this.notifier.say('Sample loaded. One paragraph strays from its section; see whether the model finds it.', 5000);
		});
	}

	private async contextFor(format: DocFormat): Promise<PackageContext | null> {
		if (format !== 'docx' && format !== 'odt') return null;
		if (this.docs.ctx?.fmt === format) return this.docs.ctx;
		const existing = this.docs.alt[format];
		if (existing) return existing;
		const pageSize = /^en-(US|CA)|^es-MX/.test(navigator.language) ? 'letter' : 'a4';
		const created = await blankContext(format, pageSize);
		this.docs.alt[format] = created;
		return created;
	}

	/** Saves in the document's format, or as `format` when given. Resolves to true on success. */
	async save(format?: DocFormat): Promise<boolean> {
		const file = this.docs.file();
		const target = format ?? file.format;
		const blocks = this.editor.blocksForSave();
		const data = this.settings.editor().embed ? this.analysis.embedData() : null;
		let out: { bytes: Bytes; mime: string; dropped: number };
		let ctx: PackageContext | null;
		try {
			ctx = await this.contextFor(target);
			out = await writeDocument(target, blocks, ctx, data);
		} catch (e) {
			log.error('save-failed', { error: errorMessage(e) });
			this.notifier.say(`Could not save: ${errorMessage(e)}`, 8000);
			return false;
		}
		const blob = new Blob([out.bytes], { type: out.mime });
		const base = file.name ? file.name.replace(/\.[^.]+$/, '') : this.editor.title().replace(/[\\/:*?"<>|]+/g, '').trim().slice(0, 80) || 'Untitled';
		let name = `${base}.${!format && file.name ? file.ext : target}`;
		let handle = format ? null : file.handle;
		let written = false;
		if (handle) written = await this.write(handle, blob);
		if (!written) {
			const picker = savePicker();
			if (picker) {
				try {
					handle = await picker({ suggestedName: name, types: [PICKER_TYPES[target]] });
					written = await this.write(handle, blob);
					if (written) name = handle.name;
				} catch (e) {
					if (e instanceof DOMException && e.name === 'AbortError') return false;
					handle = null;
				}
			}
		}
		if (!written) { download(blob, name); handle = null; }
		const ext = (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? target).toLowerCase();
		let lastModified = 0;
		if (handle) { try { lastModified = (await handle.getFile()).lastModified; } catch { lastModified = 0; } }
		if (target !== file.format) this.docs.ctx = ctx;
		this.docs.file.set({ name, ext, format: target, handle, lastModified });
		this.docs.dirty.set(false);
		this.docs.savedAt.set(Date.now());
		await this.drafts.forget();
		await this.drafts.rememberSource(ctx ? await ctx.zip.build() : null, handle);
		if (!data) await this.drafts.storeSettings(name, this.docs.settings());
		this.notifier.say(`Saved ${name}.${out.dropped ? ` ${out.dropped} table${out.dropped > 1 ? 's or images' : ' or image'} from the original format could not be carried over.` : ''}`, out.dropped ? 7000 : 2500);
		return true;
	}

	private async write(handle: FileSystemFileHandle, blob: Blob): Promise<boolean> {
		try {
			if (!(await canWrite(handle))) return false;
			const w = await handle.createWritable();
			await w.write(blob);
			await w.close();
			return true;
		} catch (e) {
			log.warn('write-failed', { error: errorMessage(e) });
			return false;
		}
	}

	/** Offers to reload when the open file was changed by another program. */
	async checkExternal(): Promise<void> {
		const file = this.docs.file();
		if (!file.handle || !file.lastModified) return;
		try {
			const f = await file.handle.getFile();
			if (f.lastModified <= file.lastModified + 1500) return;
			this.docs.file.set({ ...file, lastModified: f.lastModified });
			const handle = file.handle;
			this.notifier.ask(`${file.name} was changed in another program.${this.docs.dirty() ? ' Reloading replaces your unsaved edits here.' : ''} Readings of unchanged paragraphs are kept either way.`, [
				{ label: 'Reload the file', run: () => { this.docs.dirty.set(false); void this.open(f, handle); } },
				{ label: 'Keep this version', run: () => undefined },
			]);
		} catch { /* the file is gone or permission was revoked */ }
	}
}

function download(blob: Blob, name: string): void {
	const a = document.createElement('a');
	a.href = URL.createObjectURL(blob);
	a.download = name;
	document.body.appendChild(a);
	a.click();
	setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 3000);
}
