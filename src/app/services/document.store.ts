import { Injectable, effect, signal, untracked } from '@angular/core';
import type { PackageContext } from '../core/formats/formats';
import { EMPTY_DOC_SETTINGS, type DocFormat, type DocSettings, type PackageFormat } from '../core/model';

/** Where the open document lives. `handle` is null when the browser cannot write files back. */
export interface FileInfo {
	readonly name: string;
	readonly ext: string;
	readonly format: DocFormat;
	readonly handle: FileSystemFileHandle | null;
	readonly lastModified: number;
}
export const NEW_FILE: FileInfo = { name: '', ext: 'docx', format: 'docx', handle: null, lastModified: 0 };

/** State of the open document that is not text: file, settings, ignored suggestions. */
@Injectable({ providedIn: 'root' })
export class DocumentStore {
	readonly file = signal<FileInfo>(NEW_FILE);
	readonly settings = signal<DocSettings>(EMPTY_DOC_SETTINGS);
	readonly dirty = signal(false);
	/** Paragraphs (by block id) and other parts edited since the last save or open. Cleared whenever `dirty` turns false. */
	readonly touched = signal<ReadonlySet<string>>(new Set());
	/** When the document was last written to disk, or null when not in this session. */
	readonly savedAt = signal<number | null>(null);
	/** When the oldest unsaved change was made, or null when there is none. */
	readonly dirtySince = signal<number | null>(null);
	/** Ids of suggestions the author chose to ignore. Saved with the document. */
	readonly ignored = signal<ReadonlySet<string>>(new Set());
	/** Hashes of notes the author hid. Saved with the document. */
	readonly dismissed = signal<ReadonlySet<string>>(new Set());

	/** The package the document was read from. Writing updates it in place. */
	ctx: PackageContext | null = null;
	/** Empty packages for saving into a format the document was not read from. */
	readonly alt: Partial<Record<PackageFormat, PackageContext>> = {};

	constructor() {
		effect(() => {
			const dirty = this.dirty();
			untracked(() => {
				if (!dirty && this.touched().size) this.touched.set(new Set());
				if (dirty !== (this.dirtySince() !== null)) this.dirtySince.set(dirty ? Date.now() : null);
			});
		});
	}

	/** Records an edit to `part`: a block id, or a name such as 'settings'. */
	touch(part: string): void {
		if (!this.dirty()) { this.touched.set(new Set()); this.dirtySince.set(Date.now()); }
		this.dirty.set(true);
		if (!this.touched().has(part)) this.touched.update(s => new Set(s).add(part));
	}

	reset(file: FileInfo, settings: DocSettings, ctx: PackageContext | null, ignored: readonly string[] = [], dismissed: readonly string[] = []): void {
		this.file.set(file);
		this.settings.set(settings);
		this.ctx = ctx;
		delete this.alt.docx;
		delete this.alt.odt;
		this.ignored.set(new Set(ignored));
		this.dismissed.set(new Set(dismissed));
		this.dirty.set(false);
		this.touched.set(new Set());
		this.savedAt.set(null);
	}

	updateSettings(patch: Partial<DocSettings>): void {
		this.settings.update(s => ({ ...s, ...patch }));
		this.touch('settings');
	}

	ignore(id: string): void { this.ignored.update(s => new Set(s).add(id)); this.touch('notes'); }
	dismiss(id: string): void { this.dismissed.update(s => new Set(s).add(id)); this.touch('notes'); }
}
