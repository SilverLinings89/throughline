/** One entry point for reading and writing every supported format. */
import type { Block, Bytes, DocFormat, PackageFormat, SaveBlock } from '../model';
import { blankDocx, readDocx, writeDocx, type DocxContext } from './docx';
import { readMarkdown, writeMarkdown } from './markdown';
import { blankOdt, readOdt, writeOdt, type OdtContext } from './odt';
import { readPlainText, writePlainText } from './plain-text';

export type PackageContext = DocxContext | OdtContext;

/** A document as read from a file. `data` is the raw embedded analysis, not yet validated. */
export interface LoadedDocument {
	readonly format: DocFormat;
	readonly blocks: Block[];
	readonly ctx: PackageContext | null;
	readonly data: unknown;
}

export type FormatLookup =
	| { readonly ok: true; readonly format: DocFormat; readonly ext: string }
	| { readonly ok: false; readonly error: string };

/** Maps a file name to a format by its extension. */
export function formatOf(name: string): FormatLookup {
	const ext = (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? '').toLowerCase();
	switch (ext) {
		case 'docx': case 'docm': case 'dotx': return { ok: true, format: 'docx', ext };
		case 'odt': case 'ott': return { ok: true, format: 'odt', ext };
		case 'md': case 'markdown': return { ok: true, format: 'md', ext };
		case 'txt': return { ok: true, format: 'txt', ext };
		case 'doc': return { ok: false, error: 'Old .doc files cannot be read. Open the file in Word or LibreOffice, save it as .docx, then open that.' };
		default: return { ok: false, error: 'Throughline opens .docx, .odt, .md and .txt files.' };
	}
}

/** Reads a file. Throws an `Error` with a user-facing message when the file cannot be read. */
export async function readDocument(name: string, bytes: Bytes): Promise<LoadedDocument> {
	const f = formatOf(name);
	if (!f.ok) throw new Error(f.error);
	switch (f.format) {
		case 'docx': { const r = await readDocx(bytes); return { format: 'docx', ...r }; }
		case 'odt': { const r = await readOdt(bytes); return { format: 'odt', ...r }; }
		case 'md': return { format: 'md', blocks: readMarkdown(new TextDecoder().decode(bytes)), ctx: null, data: null };
		case 'txt': return { format: 'txt', blocks: readPlainText(new TextDecoder().decode(bytes)), ctx: null, data: null };
	}
}

/** Creates an empty package to save into when the document did not come from that format. */
export function blankContext(format: PackageFormat, pageSize: 'a4' | 'letter'): Promise<PackageContext> {
	return format === 'docx' ? blankDocx(pageSize) : blankOdt();
}

export interface WriteResult {
	readonly bytes: Bytes;
	readonly mime: string;
	/** Kept items (tables, images) that could not be carried into this format. */
	readonly dropped: number;
}

export const MIME: Record<DocFormat, string> = {
	docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	odt: 'application/vnd.oasis.opendocument.text',
	md: 'text/markdown',
	txt: 'text/plain',
};

/** Writes blocks in `format`. For packages, `ctx` must be a context of the same format. */
export async function writeDocument(format: DocFormat, blocks: readonly SaveBlock[], ctx: PackageContext | null, data: unknown): Promise<WriteResult> {
	const dropped = blocks.filter(b => b.type === 'opaque' && b.meta.fmt !== format).length;
	const encode = (s: string): Bytes => new TextEncoder().encode(s);
	switch (format) {
		case 'docx':
			if (ctx?.fmt !== 'docx') throw new Error('A .docx context is required to save as .docx.');
			return { bytes: await writeDocx(blocks, ctx, data), mime: MIME.docx, dropped };
		case 'odt':
			if (ctx?.fmt !== 'odt') throw new Error('An .odt context is required to save as .odt.');
			return { bytes: await writeOdt(blocks, ctx, data), mime: MIME.odt, dropped };
		case 'md': return { bytes: encode(writeMarkdown(blocks)), mime: MIME.md, dropped };
		case 'txt': return { bytes: encode(writePlainText(blocks)), mime: MIME.txt, dropped };
	}
}
