import { describe, expect, it } from 'vitest';
import { fixture } from '#fixtures';
import { readDocument, writeDocument, blankContext } from '../src/app/core/formats/formats';
import { readDocx } from '../src/app/core/formats/docx';
import { ZipArchive } from '../src/app/core/zip/zip-archive';
import type { SaveBlock } from '../src/app/core/model';
import { textRun } from '../src/app/core/util/runs';
import { asUnchanged, textOf } from './support/helpers';

describe('zip archive', () => {
	it('writes mimetype first and uncompressed, and reads back what it wrote', async () => {
		const z = new ZipArchive();
		z.set('content.xml', '<x>' + 'long text '.repeat(50) + '</x>');
		z.set('mimetype', 'application/vnd.oasis.opendocument.text');
		const bytes = await z.build();
		expect(new TextDecoder().decode(bytes.subarray(30, 38))).toBe('mimetype');
		const back = await ZipArchive.open(bytes);
		expect(await back.text('mimetype')).toBe('application/vnd.oasis.opendocument.text');
		expect((await back.text('content.xml'))?.length).toBe(507);
	});
	it('rejects bytes that are not a zip file', async () => {
		await expect(ZipArchive.open(new TextEncoder().encode('hello'))).rejects.toThrow('not a .docx or .odt');
	});
});

describe('docx', () => {
	it('reads headings, lists, kept tables and formatting from a LibreOffice file', async () => {
		const doc = await readDocument('a.docx', await fixture('libreoffice.docx'));
		expect(doc.blocks.map(b => b.type).join(',')).toBe('h1,p,p,h2,p,ul,ul,ol,ol,opaque,h2,p');
		const first = doc.blocks[1];
		expect(first.type === 'p' && first.runs.some(r => r.kind === 'text' && r.b && r.t === 'compromise')).toBe(true);
		expect(first.type === 'p' && first.runs.some(r => r.kind === 'text' && r.href === 'https://example.org/source')).toBe(true);
	});

	it('writes untouched paragraphs back byte for byte', async () => {
		const bytes = await fixture('python-docx.docx');
		const doc = await readDocument('a.docx', bytes);
		if (doc.ctx?.fmt !== 'docx') throw new Error('expected a docx context');
		const before = doc.ctx.xmlStr;
		const out = await writeDocument('docx', asUnchanged(doc.blocks), doc.ctx, null);
		const again = await readDocx(out.bytes);
		const body = (x: string): string => x.slice(x.indexOf('<w:body>'), x.indexOf('</w:body>'));
		expect(body(again.ctx.xmlStr).replace(/ xmlns:\w+="[^"]*"/g, '')).toBe(body(before).replace(/ xmlns:\w+="[^"]*"/g, ''));
	});

	it('keeps footnote references through an edit and restarts new numbered lists', async () => {
		const doc = await readDocument('a.docx', await fixture('footnote.docx'));
		if (doc.ctx?.fmt !== 'docx') throw new Error('expected a docx context');
		const blocks: SaveBlock[] = doc.blocks.map((b, i) => (i === 1 && b.type === 'p' ? { ...b, runs: [textRun('Edited. '), ...b.runs], unchanged: false } : { ...b, unchanged: true }));
		blocks.push({ type: 'ol', runs: [textRun('one')], meta: null, unchanged: false }, { type: 'ol', runs: [textRun('two')], meta: null, unchanged: false });
		const out = await writeDocument('docx', blocks, doc.ctx, { app: 'Throughline', v: 1 });
		const back = await readDocument('b.docx', out.bytes);
		expect(textOf(back.blocks[1])).toContain('Edited. Dieser Satz hat eine Fußnote[note 1]');
		expect(back.blocks.slice(-2).map(b => b.type).join(',')).toBe('ol,ol');
		expect(back.data).toEqual({ app: 'Throughline', v: 1 });
	});

	it('creates a valid document from scratch with headings, lists and links', async () => {
		const ctx = await blankContext('docx', 'a4');
		const blocks: SaveBlock[] = [
			{ type: 'h1', runs: [textRun('Title')], meta: null, unchanged: false },
			{ type: 'p', runs: [textRun('See '), textRun('this & that', { href: 'https://example.com/?a=1&b=2', b: true })], meta: null, unchanged: false },
			{ type: 'ul', runs: [textRun('bullet')], meta: null, unchanged: false },
		];
		const back = await readDocument('n.docx', (await writeDocument('docx', blocks, ctx, null)).bytes);
		expect(back.blocks.map(b => `${b.type}:${textOf(b)}`).join('|')).toBe('h1:Title|p:See this & that|ul:bullet');
		const p = back.blocks[1];
		expect(p.type === 'p' && p.runs.some(r => r.kind === 'text' && r.href === 'https://example.com/?a=1&b=2' && r.b)).toBe(true);
	});

	it('removes the analysis part when saving without data', async () => {
		const doc = await readDocument('a.docx', await fixture('v1-with-readings.docx'));
		if (doc.ctx?.fmt !== 'docx') throw new Error('expected a docx context');
		expect(doc.data).toBeTruthy();
		const out = await writeDocument('docx', asUnchanged(doc.blocks), doc.ctx, null);
		const back = await ZipArchive.open(out.bytes);
		expect(back.names().some(n => n.startsWith('customXml/'))).toBe(false);
	});
});

describe('odt', () => {
	it('reads a heading stored as a styled paragraph, lists, tables and footnotes', async () => {
		const doc = await readDocument('a.odt', await fixture('libreoffice.odt'));
		expect(doc.blocks.map(b => b.type).join(',')).toBe('h1,p,p,h2,p,ul,ul,ol,ol,opaque,h2,p');
		const note = await readDocument('b.odt', await fixture('footnote.odt'));
		expect(textOf(note.blocks[1])).toContain('Fußnote[note 1]');
	});

	it('round-trips edits, embedded data and the manifest entry', async () => {
		const doc = await readDocument('a.odt', await fixture('footnote.odt'));
		if (doc.ctx?.fmt !== 'odt') throw new Error('expected an odt context');
		const blocks: SaveBlock[] = doc.blocks.map((b, i) => (i === 1 && b.type === 'p' ? { ...b, runs: [...b.runs, textRun('  two spaces', { i: true })], unchanged: false } : { ...b, unchanged: true }));
		const out = await writeDocument('odt', blocks, doc.ctx, { app: 'Throughline', v: 1 });
		const zip = await ZipArchive.open(out.bytes);
		expect(await zip.text('META-INF/manifest.xml')).toContain('Throughline/analysis.json');
		const back = await readDocument('b.odt', out.bytes);
		expect(textOf(back.blocks[1])).toContain('[note 1]');
		expect(textOf(back.blocks[1]).endsWith('  two spaces')).toBe(true);
		expect(back.data).toEqual({ app: 'Throughline', v: 1 });
	});

	it('drops tokens from another format instead of writing foreign XML', async () => {
		const src = await readDocument('a.docx', await fixture('footnote.docx'));
		const ctx = await blankContext('odt', 'a4');
		const out = await writeDocument('odt', asUnchanged(src.blocks), ctx, null);
		const xml = await (await ZipArchive.open(out.bytes)).text('content.xml');
		expect(xml?.includes('w:footnoteReference')).toBe(false);
	});
});

describe('markdown and plain text', () => {
	it('round-trips headings, lists, bold, italic and links', async () => {
		const md = '# Title\n\nSome **bold** and *italic* with a [link](https://x.org).\n\n- one\n- two\n\n1. first\n2. second\n';
		const doc = await readDocument('a.md', new TextEncoder().encode(md));
		const out = await writeDocument('md', asUnchanged(doc.blocks), null, null);
		expect(new TextDecoder().decode(out.bytes)).toBe(md);
	});
	it('splits plain text on blank lines', async () => {
		const doc = await readDocument('a.txt', new TextEncoder().encode('one\nstill one\n\ntwo'));
		expect(doc.blocks.map(textOf)).toEqual(['one still one', 'two']);
	});
	it('refuses old .doc files with a clear message', async () => {
		await expect(readDocument('old.doc', new Uint8Array(4))).rejects.toThrow('save it as .docx');
	});
});
