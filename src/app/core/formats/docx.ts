/**
 * .docx reader and writer.
 *
 * Reading turns `word/document.xml` into blocks. Writing rebuilds only the `<w:body>`:
 * unchanged paragraphs are emitted from their original XML, so Word formatting,
 * comments and section breaks survive. Everything outside the body is left alone.
 */
import type { Block, BlockMeta, BlockType, Bytes, DocxMeta, Run, SaveBlock } from '../model';
import { mergeRuns, textRun } from '../util/runs';
import { escapeXml } from '../util/strings';
import { childElement, childElements, ensureRootNamespace, jsonForXml, parseXml, replaceElementContent, resolvePath, serializeXml } from '../xml/xml';
import { ZipArchive } from '../zip/zip-archive';

export const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';
const REL_T = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
const MC_NS = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
const MATH_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/math';
/** Namespace of the custom XML part that carries the analysis. */
export const ANALYSIS_URN = 'urn:throughline:analysis';

const HIDDEN_BODY = new Set(['bookmarkStart', 'bookmarkEnd', 'commentRangeStart', 'commentRangeEnd', 'permStart', 'permEnd', 'proofErr', 'moveFromRangeStart', 'moveFromRangeEnd', 'moveToRangeStart', 'moveToRangeEnd', 'customXmlInsRangeStart', 'customXmlInsRangeEnd', 'customXmlDelRangeStart', 'customXmlDelRangeEnd']);

interface Rel { readonly type: string; readonly target: string; readonly external: boolean }
interface StyleInfo {
	readonly type: string | null; readonly name: string; readonly basedOn: string | null; readonly isDefault: boolean;
	readonly outline: number | null; readonly numId: string | null; readonly b: boolean | null; readonly i: boolean | null;
}
interface StyleIds { h1: string | null; h2: string | null; h3: string | null; link: string | null; listPara: string | null }
interface StyleTable { readonly byId: Map<string, StyleInfo>; readonly normal: string | null; readonly ids: StyleIds }
/** numId → (level → number format) */
type Numbering = Map<string, Map<string, string | null>>;

/** Everything needed to write a .docx back. Mutable: writing updates it. */
export interface DocxContext {
	readonly fmt: 'docx';
	readonly zip: ZipArchive;
	readonly main: string;
	readonly dir: string;
	readonly relsPath: string;
	xmlStr: string;
	stylesPath: string | null;
	numberingPath: string | null;
	readonly styles: StyleTable;
	readonly numbering: Numbering;
	readonly rels: Map<string, Rel>;
	notes: number;
	sectPrXml: string;
	tailPre: string;
	customPath: string | null;
}

const wAttr = (el: Element | null, name = 'val'): string | null => (el ? el.getAttributeNS(W, name) : null);
function onOff(el: Element | null): boolean | null {
	if (!el) return null;
	const v = wAttr(el);
	return !(v === '0' || v === 'false' || v === 'off' || v === 'none');
}

async function readRels(zip: ZipArchive, path: string): Promise<Map<string, Rel>> {
	const map = new Map<string, Rel>();
	const text = await zip.text(path);
	if (!text) return map;
	for (const r of Array.from(parseXml(text).getElementsByTagNameNS(PKG_REL, 'Relationship'))) {
		map.set(r.getAttribute('Id') ?? '', { type: r.getAttribute('Type') ?? '', target: r.getAttribute('Target') ?? '', external: r.getAttribute('TargetMode') === 'External' });
	}
	return map;
}

function resolveStyle<T>(st: StyleTable, id: string | null, pick: (s: StyleInfo) => T | null): T | null {
	let s = id ? st.byId.get(id) : undefined;
	for (let k = 0; s && k < 10; k++) {
		const v = pick(s);
		if (v !== null) return v;
		s = s.basedOn ? st.byId.get(s.basedOn) : undefined;
	}
	return null;
}

function parseStyles(doc: XMLDocument | null): StyleTable {
	const byId = new Map<string, StyleInfo>();
	if (doc) for (const s of Array.from(doc.getElementsByTagNameNS(W, 'style'))) {
		const pPr = childElement(s, 'pPr');
		const rPr = childElement(s, 'rPr');
		const numPr = childElement(pPr, 'numPr');
		const ol = wAttr(childElement(pPr, 'outlineLvl'));
		const dflt = s.getAttributeNS(W, 'default');
		byId.set(wAttr(s, 'styleId') ?? '', {
			type: wAttr(s, 'type'), name: (wAttr(childElement(s, 'name')) ?? '').toLowerCase(), basedOn: wAttr(childElement(s, 'basedOn')),
			isDefault: dflt === '1' || dflt === 'true', outline: ol === null ? null : Number(ol),
			numId: numPr ? wAttr(childElement(numPr, 'numId')) : null, b: onOff(childElement(rPr, 'b')), i: onOff(childElement(rPr, 'i')),
		});
	}
	const byName = (n: string): string | null => { for (const [id, s] of byId) if (s.name === n) return id; return null; };
	let normal: string | null = null;
	for (const [id, s] of byId) if (s.type === 'paragraph' && s.isDefault) normal = id;
	return {
		byId, normal: normal ?? (byId.has('Normal') ? 'Normal' : null),
		ids: { h1: byName('heading 1'), h2: byName('heading 2'), h3: byName('heading 3'), link: byName('hyperlink'), listPara: byName('list paragraph') },
	};
}

function parseNumbering(doc: XMLDocument | null): Numbering {
	const abstract = new Map<string, Map<string, string | null>>();
	const nums: Numbering = new Map();
	if (!doc) return nums;
	for (const a of Array.from(doc.getElementsByTagNameNS(W, 'abstractNum'))) {
		const levels = new Map<string, string | null>();
		for (const l of childElements(a, 'lvl')) levels.set(wAttr(l, 'ilvl') ?? '0', wAttr(childElement(l, 'numFmt')));
		abstract.set(wAttr(a, 'abstractNumId') ?? '', levels);
	}
	for (const n of Array.from(doc.getElementsByTagNameNS(W, 'num'))) {
		nums.set(wAttr(n, 'numId') ?? '', abstract.get(wAttr(childElement(n, 'abstractNumId')) ?? '') ?? new Map());
	}
	return nums;
}

function headingLevel(st: StyleTable, styleId: string | null, pPr: Element | null): number {
	const direct = wAttr(childElement(pPr, 'outlineLvl'));
	if (direct !== null) return Number(direct) < 9 ? Number(direct) + 1 : 0;
	if (!styleId) return 0;
	const name = st.byId.get(styleId)?.name ?? '';
	const m = /^heading\s*(\d)$/.exec(name) ?? /^heading(\d)$/i.exec(styleId);
	if (m) return Number(m[1]);
	if (name === 'title') return 1;
	const ol = resolveStyle(st, styleId, s => s.outline);
	return ol !== null && ol < 9 ? ol + 1 : 0;
}

function opaque(label: string, meta: BlockMeta): Block {
	return { type: 'opaque', label, meta };
}

function readParagraph(p: Element, ctx: DocxContext, pre: string): Block {
	const pPr = childElement(p, 'pPr');
	const metaBase = { fmt: 'docx' as const, xml: serializeXml(p), pPrXml: pPr ? serializeXml(pPr) : '', pre };
	if (['drawing', 'pict', 'object'].some(n => p.getElementsByTagNameNS(W, n).length) || p.getElementsByTagNameNS(MC_NS, 'AlternateContent').length) {
		return opaque('Image', { ...metaBase, type: 'opaque', numId: null });
	}
	if (p.getElementsByTagNameNS(MATH_NS, 'oMath').length) return opaque('Formula', { ...metaBase, type: 'opaque', numId: null });
	const styleId = wAttr(childElement(pPr, 'pStyle'));
	const level = headingLevel(ctx.styles, styleId, pPr);
	let type: BlockType = level ? (level === 1 ? 'h1' : level === 2 ? 'h2' : 'h3') : 'p';
	let numId: string | null = null;
	if (!level) {
		const numPr = childElement(pPr, 'numPr');
		let ilvl = '0';
		if (numPr) { numId = wAttr(childElement(numPr, 'numId')); ilvl = wAttr(childElement(numPr, 'ilvl')) ?? '0'; }
		else if (styleId) numId = resolveStyle(ctx.styles, styleId, s => s.numId);
		if (numId && numId !== '0') {
			const levels = ctx.numbering.get(numId);
			type = (levels?.get(ilvl) ?? levels?.get('0')) === 'bullet' ? 'ul' : 'ol';
		} else numId = null;
	}
	const runs: Run[] = [];
	readRuns(p, ctx, { b: false, i: false, href: null }, runs);
	return { type, runs: mergeRuns(runs), meta: { ...metaBase, type, numId } satisfies DocxMeta };
}

interface Fmt { b: boolean; i: boolean; href: string | null }
function readRuns(node: Element, ctx: DocxContext, f: Fmt, out: Run[]): void {
	for (const c of Array.from(node.children)) {
		if (c.namespaceURI !== W) continue;
		switch (c.localName) {
			case 'r': readRun(c, ctx, f, out); break;
			case 'hyperlink': {
				const id = c.getAttributeNS(R_NS, 'id');
				const anchor = wAttr(c, 'anchor');
				const rel = id ? ctx.rels.get(id) : undefined;
				readRuns(c, ctx, { ...f, href: rel ? rel.target : anchor ? `#${anchor}` : f.href }, out);
				break;
			}
			case 'ins': case 'moveTo': case 'smartTag': case 'customXml': case 'fldSimple': case 'sdt': case 'sdtContent': case 'dir': case 'bdo':
				readRuns(c, ctx, f, out);
				break;
			default: break;
		}
	}
}

function readRun(r: Element, ctx: DocxContext, f: Fmt, out: Run[]): void {
	const rPr = childElement(r, 'rPr');
	let b = f.b;
	let i = f.i;
	const rs = wAttr(childElement(rPr, 'rStyle'));
	if (rs) {
		b = resolveStyle(ctx.styles, rs, s => s.b) ?? b;
		i = resolveStyle(ctx.styles, rs, s => s.i) ?? i;
	}
	b = onOff(childElement(rPr, 'b')) ?? b;
	i = onOff(childElement(rPr, 'i')) ?? i;
	if (r.getElementsByTagNameNS(W, 'footnoteReference').length || r.getElementsByTagNameNS(W, 'endnoteReference').length) {
		ctx.notes++;
		out.push({ kind: 'token', fmt: 'docx', xml: serializeXml(r), label: String(ctx.notes) });
		return;
	}
	let t = '';
	for (const c of Array.from(r.children)) {
		if (c.namespaceURI !== W) continue;
		switch (c.localName) {
			case 't': t += c.textContent ?? ''; break;
			case 'tab': t += '\t'; break;
			case 'br': { const ty = wAttr(c, 'type'); if (ty !== 'page' && ty !== 'column') t += '\n'; break; }
			case 'cr': t += '\n'; break;
			case 'noBreakHyphen': t += '\u2011'; break;
			case 'softHyphen': t += '\u00AD'; break;
			case 'sym': {
				const code = parseInt(wAttr(c, 'char') ?? '', 16);
				if (code) t += String.fromCharCode(code >= 0xf000 ? code - 0xf000 : code);
				break;
			}
			default: break;
		}
	}
	if (t) out.push(textRun(t, { b, i, href: f.href }));
}

/** Reads a .docx package. Returns blocks, the context for writing, and embedded analysis data if present. */
export async function readDocx(bytes: Bytes): Promise<{ blocks: Block[]; ctx: DocxContext; data: unknown }> {
	const zip = await ZipArchive.open(bytes);
	if (!zip.has('[Content_Types].xml')) throw new Error('This is not a Word document.');
	let main = 'word/document.xml';
	for (const r of (await readRels(zip, '_rels/.rels')).values()) if (/\/officeDocument$/.test(r.type)) main = resolvePath('', r.target);
	const dir = main.slice(0, main.lastIndexOf('/') + 1);
	const relsPath = `${dir}_rels/${main.slice(dir.length)}.rels`;
	const rels = await readRels(zip, relsPath);
	const part = (suffix: string): string | null => {
		for (const r of rels.values()) if (r.type.endsWith(`/${suffix}`) && !r.external) return resolvePath(dir, r.target);
		return null;
	};
	const stylesPath = part('styles');
	const numberingPath = part('numbering');
	const stylesXml = stylesPath ? await zip.text(stylesPath) : null;
	const numberingXml = numberingPath ? await zip.text(numberingPath) : null;
	const xmlStr = await zip.text(main);
	if (!xmlStr) throw new Error('The Word document has no main text part.');
	const doc = parseXml(xmlStr);
	const body = doc.getElementsByTagNameNS(W, 'body')[0];
	if (!body) throw new Error('This looks like a "Strict Open XML" document. Save it in Word as a regular .docx and open it again.');
	const ctx: DocxContext = {
		fmt: 'docx', zip, main, dir, relsPath, xmlStr, stylesPath, numberingPath,
		styles: parseStyles(stylesXml ? parseXml(stylesXml) : null), numbering: parseNumbering(numberingXml ? parseXml(numberingXml) : null),
		rels, notes: 0, sectPrXml: '', tailPre: '', customPath: null,
	};
	const blocks: Block[] = [];
	let pre = '';
	const kids = Array.from(body.children);
	for (const el of kids) {
		const ln = el.localName;
		if (el.namespaceURI === W && HIDDEN_BODY.has(ln)) { pre += serializeXml(el); continue; }
		if (ln === 'sectPr' && el === kids[kids.length - 1]) { ctx.sectPrXml = serializeXml(el); continue; }
		const meta = { fmt: 'docx' as const, type: 'opaque' as const, xml: serializeXml(el), pPrXml: '', numId: null, pre };
		if (ln === 'p' && el.namespaceURI === W) blocks.push(readParagraph(el, ctx, pre));
		else if (ln === 'tbl') blocks.push(opaque('Table', meta));
		else if (ln === 'sdt') {
			const gallery = el.getElementsByTagNameNS(W, 'docPartGallery')[0];
			blocks.push(opaque(gallery && /Contents/i.test(wAttr(gallery) ?? '') ? 'Table of contents' : 'Content control', meta));
		} else blocks.push(opaque('Embedded content', meta));
		pre = '';
	}
	ctx.tailPre = pre;
	let data: unknown = null;
	for (const r of rels.values()) {
		if (!r.type.endsWith('/customXml')) continue;
		const p = resolvePath(dir, r.target);
		const text = await zip.text(p);
		if (text?.includes(ANALYSIS_URN)) {
			ctx.customPath = p;
			try { data = JSON.parse(parseXml(text).documentElement.textContent ?? 'null'); } catch { data = null; }
		}
	}
	return { blocks, ctx, data };
}

/** Builds an empty .docx and returns its context, ready for `writeDocx`. */
export async function blankDocx(pageSize: 'a4' | 'letter'): Promise<DocxContext> {
	const z = new ZipArchive();
	const a4 = pageSize === 'a4';
	z.set('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="${CT_NS}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`);
	z.set('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL_T}officeDocument" Target="word/document.xml"/></Relationships>`);
	z.set('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL_T}styles" Target="styles.xml"/></Relationships>`);
	z.set('word/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Georgia" w:hAnsi="Georgia" w:eastAsia="Georgia" w:cs="Georgia"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>${[1, 2, 3].map(n => headingStyleXml(n, 'Normal')).join('')}<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:sz w:val="48"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="60"/><w:ind w:left="720"/><w:contextualSpacing/></w:pPr></w:style>${linkStyleXml()}</w:styles>`);
	z.set('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="${W}" xmlns:r="${R_NS}"><w:body><w:sectPr><w:pgSz w:w="${a4 ? 11906 : 12240}" w:h="${a4 ? 16838 : 15840}"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`);
	return (await readDocx(await z.build())).ctx;
}

/**
 * Writes blocks into the package held by `ctx` and returns the new file.
 * `data` goes into a custom XML part; pass null to remove that part.
 */
export async function writeDocx(blocks: readonly SaveBlock[], ctx: DocxContext, data: unknown): Promise<Bytes> {
	const w = new DocxWriter(ctx, blocks);
	await w.load();
	const body = w.body();
	let head = ensureRootNamespace(ensureRootNamespace(ctx.xmlStr, 'w', W), 'r', R_NS);
	const bodyName = /<((?:[A-Za-z_][\w.-]*:)?)body[\s>/]/.exec(head)?.[1] ?? 'w:';
	head = replaceElementContent(head, `${bodyName}body`, body + ctx.tailPre + ctx.sectPrXml);
	ctx.zip.set(ctx.main, head);
	ctx.xmlStr = head;
	await w.writeData(data);
	w.flush();
	return ctx.zip.build();
}

const RPR_KEEP = ['rFonts', 'color', 'w', 'kern', 'sz', 'szCs', 'lang'] as const;
type BaseRPr = Partial<Record<(typeof RPR_KEEP)[number], string>>;
const baseCache = new WeakMap<DocxMeta, BaseRPr | null>();

/** Run properties of the first text run of a paragraph, limited to fonts, size, color and language. */
function baseRunProps(m: DocxMeta | null): BaseRPr | null {
	if (!m) return null;
	const cached = baseCache.get(m);
	if (cached !== undefined) return cached;
	let base: BaseRPr | null = null;
	try {
		const p = parseXml(m.xml).documentElement;
		const r = Array.from(p.getElementsByTagNameNS(W, 'r')).find(x => childElement(x, 't'));
		const rPr = r ? childElement(r, 'rPr') : null;
		if (rPr) {
			base = {};
			for (const c of Array.from(rPr.children)) {
				const key = RPR_KEEP.find(k => k === c.localName);
				if (key && c.namespaceURI === W) base[key] = serializeXml(c);
			}
		}
	} catch { base = null; }
	baseCache.set(m, base);
	return base;
}

class DocxWriter {
	private relsDoc!: XMLDocument;
	private ctDoc!: XMLDocument;
	private stylesDoc: XMLDocument | null = null;
	private numDoc: XMLDocument | null = null;
	private readonly dirty = new Set<'rels' | 'ct' | 'styles' | 'num'>();

	constructor(private readonly ctx: DocxContext, private readonly blocks: readonly SaveBlock[]) {}

	async load(): Promise<void> {
		const { zip } = this.ctx;
		this.relsDoc = parseXml((await zip.text(this.ctx.relsPath)) ?? `<Relationships xmlns="${PKG_REL}"/>`);
		this.ctDoc = parseXml((await zip.text('[Content_Types].xml')) ?? `<Types xmlns="${CT_NS}"/>`);
		const s = this.ctx.stylesPath ? await zip.text(this.ctx.stylesPath) : null;
		const n = this.ctx.numberingPath ? await zip.text(this.ctx.numberingPath) : null;
		this.stylesDoc = s ? parseXml(s) : null;
		this.numDoc = n ? parseXml(n) : null;
	}

	flush(): void {
		const { zip } = this.ctx;
		if (this.dirty.has('rels')) zip.set(this.ctx.relsPath, serializeXml(this.relsDoc));
		if (this.dirty.has('ct')) zip.set('[Content_Types].xml', serializeXml(this.ctDoc));
		if (this.dirty.has('styles') && this.stylesDoc && this.ctx.stylesPath) zip.set(this.ctx.stylesPath, serializeXml(this.stylesDoc));
		if (this.dirty.has('num') && this.numDoc && this.ctx.numberingPath) zip.set(this.ctx.numberingPath, serializeXml(this.numDoc));
	}

	private relTarget(path: string): string {
		const { dir } = this.ctx;
		return path.startsWith(dir) ? path.slice(dir.length) : '../'.repeat(dir.split('/').length - 1) + path;
	}
	private relEls(): Element[] { return Array.from(this.relsDoc.documentElement.children); }
	private addRel(type: string, target: string, external: boolean): string {
		for (const r of this.relEls()) if (r.getAttribute('Type') === REL_T + type && r.getAttribute('Target') === target) return r.getAttribute('Id') ?? '';
		const ids = new Set(this.relEls().map(r => r.getAttribute('Id')));
		let n = 1;
		while (ids.has(`rIdTl${n}`)) n++;
		const id = `rIdTl${n}`;
		const el = this.relsDoc.createElementNS(PKG_REL, 'Relationship');
		el.setAttribute('Id', id); el.setAttribute('Type', REL_T + type); el.setAttribute('Target', target);
		if (external) el.setAttribute('TargetMode', 'External');
		this.relsDoc.documentElement.appendChild(el);
		this.ctx.rels.set(id, { type: REL_T + type, target, external });
		this.dirty.add('rels');
		return id;
	}
	private addOverride(part: string, type: string): void {
		const root = this.ctDoc.documentElement;
		for (const o of Array.from(root.children)) if (o.localName === 'Override' && (o.getAttribute('PartName') ?? '').toLowerCase() === part.toLowerCase()) return;
		const el = this.ctDoc.createElementNS(CT_NS, 'Override');
		el.setAttribute('PartName', part); el.setAttribute('ContentType', type);
		root.appendChild(el);
		this.dirty.add('ct');
	}
	private ensureDefault(ext: string, type: string): void {
		const root = this.ctDoc.documentElement;
		for (const o of Array.from(root.children)) if (o.localName === 'Default' && (o.getAttribute('Extension') ?? '').toLowerCase() === ext) return;
		const el = this.ctDoc.createElementNS(CT_NS, 'Default');
		el.setAttribute('Extension', ext); el.setAttribute('ContentType', type);
		root.insertBefore(el, root.firstChild);
		this.dirty.add('ct');
	}
	private importSnippet(doc: XMLDocument, xml: string): Node { return doc.importNode(parseXml(xml).documentElement, true); }

	private ensureStyles(): XMLDocument {
		if (this.stylesDoc) return this.stylesDoc;
		this.stylesDoc = parseXml(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:styles xmlns:w="${W}"/>`);
		this.ctx.stylesPath = `${this.ctx.dir}styles.xml`;
		this.addRel('styles', this.relTarget(this.ctx.stylesPath), false);
		this.addOverride(`/${this.ctx.stylesPath}`, 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml');
		this.dirty.add('styles');
		return this.stylesDoc;
	}
	private hasStyle(id: string): boolean {
		return !!this.stylesDoc && Array.from(this.stylesDoc.getElementsByTagNameNS(W, 'style')).some(s => wAttr(s, 'styleId') === id);
	}
	private headingId(level: 1 | 2 | 3): string {
		const key = level === 1 ? 'h1' : level === 2 ? 'h2' : 'h3';
		const known = this.ctx.styles.ids[key];
		if (known) return known;
		const doc = this.ensureStyles();
		const id = `Heading${level}`;
		if (!this.hasStyle(id)) { doc.documentElement.appendChild(this.importSnippet(doc, headingStyleXml(level, this.ctx.styles.normal))); this.dirty.add('styles'); }
		this.ctx.styles.ids[key] = id;
		return id;
	}
	private linkStyleId(): string {
		if (this.ctx.styles.ids.link) return this.ctx.styles.ids.link;
		const doc = this.ensureStyles();
		if (!this.hasStyle('Hyperlink')) { doc.documentElement.appendChild(this.importSnippet(doc, linkStyleXml())); this.dirty.add('styles'); }
		this.ctx.styles.ids.link = 'Hyperlink';
		return 'Hyperlink';
	}
	private ensureNumbering(): XMLDocument {
		if (this.numDoc) return this.numDoc;
		this.numDoc = parseXml(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:numbering xmlns:w="${W}"/>`);
		this.ctx.numberingPath ??= `${this.ctx.dir}numbering.xml`;
		this.addRel('numbering', this.relTarget(this.ctx.numberingPath), false);
		this.addOverride(`/${this.ctx.numberingPath}`, 'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml');
		this.dirty.add('num');
		return this.numDoc;
	}
	private findNumId(kind: 'ul' | 'ol'): string | null {
		for (const [id, levels] of this.ctx.numbering) {
			const f = levels.get('0');
			if (kind === 'ul' ? f === 'bullet' : f && f !== 'bullet' && f !== 'none') return id;
		}
		return null;
	}
	private newNum(kind: 'ul' | 'ol'): string {
		const doc = this.ensureNumbering();
		const root = doc.documentElement;
		const nums = (): Element[] => childElements(root, 'num');
		let absId: string | null = null;
		const existing = this.findNumId(kind);
		if (existing) { const n = nums().find(x => wAttr(x, 'numId') === existing); absId = n ? wAttr(childElement(n, 'abstractNumId')) : null; }
		if (absId === null) {
			const ids = childElements(root, 'abstractNum').map(a => Number(wAttr(a, 'abstractNumId')));
			absId = String(Math.max(-1, ...ids) + 1);
			root.insertBefore(this.importSnippet(doc, abstractNumXml(kind, absId)), nums()[0] ?? childElement(root, 'numIdMacAtCleanup'));
		}
		const numId = String(Math.max(0, ...nums().map(n => Number(wAttr(n, 'numId')))) + 1);
		const restart = kind === 'ol' ? '<w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride>' : '';
		root.insertBefore(this.importSnippet(doc, `<w:num xmlns:w="${W}" w:numId="${numId}"><w:abstractNumId w:val="${absId}"/>${restart}</w:num>`), childElement(root, 'numIdMacAtCleanup'));
		this.ctx.numbering.set(numId, new Map([['0', kind === 'ul' ? 'bullet' : 'decimal']]));
		this.dirty.add('num');
		return numId;
	}
	private templatePPr(type: BlockType, k: number): string | null {
		for (let d = 1; d < this.blocks.length; d++) {
			for (const j of [k - d, k + d]) {
				const m = this.blocks[j]?.meta;
				if (m && m.fmt === 'docx' && m.type === type && m.pPrXml) return stripPPr(m.pPrXml);
			}
		}
		return null;
	}

	/** The new content of `<w:body>`, without the final section properties. */
	body(): string {
		const parts: string[] = [];
		let group: { kind: 'ul' | 'ol'; numId: string | null } | null = null;
		this.blocks.forEach((b, k) => {
			const m = b.meta?.fmt === 'docx' ? b.meta : null;
			const pre = m?.pre ?? '';
			if (b.type === 'opaque') { if (m) parts.push(pre + m.xml); group = null; return; }
			if (b.unchanged && m) { parts.push(pre + m.xml); group = b.type === 'ul' || b.type === 'ol' ? { kind: b.type, numId: m.numId } : null; return; }
			let pPr = '';
			if (b.type === 'ul' || b.type === 'ol') {
				let numId: string;
				if (m && m.type === b.type && m.numId) numId = m.numId;
				else if (group && group.kind === b.type && group.numId) numId = group.numId;
				else numId = b.type === 'ul' ? this.findNumId('ul') ?? this.newNum('ul') : this.newNum('ol');
				group = { kind: b.type, numId };
				const lp = this.ctx.styles.ids.listPara;
				pPr = m && m.type === b.type && m.pPrXml ? m.pPrXml : `<w:pPr>${lp ? `<w:pStyle w:val="${escapeXml(lp)}"/>` : ''}<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr></w:pPr>`;
			} else {
				group = null;
				if (m && m.type === b.type) pPr = m.pPrXml;
				else {
					const level = b.type === 'h1' ? 1 : b.type === 'h2' ? 2 : b.type === 'h3' ? 3 : 0;
					pPr = this.templatePPr(b.type, k) ?? (level ? `<w:pPr><w:pStyle w:val="${escapeXml(this.headingId(level))}"/></w:pPr>` : '');
				}
			}
			parts.push(`${pre}<w:p>${pPr}${this.runsXml(b.runs, baseRunProps(m))}</w:p>`);
		});
		return parts.join('');
	}

	private runsXml(runs: readonly Run[], base: BaseRPr | null): string {
		let out = '';
		let i = 0;
		while (i < runs.length) {
			const r = runs[i];
			if (r.kind === 'text' && r.href) {
				const href = r.href;
				const style = this.linkStyleId();
				let inner = '';
				while (i < runs.length) {
					const x = runs[i];
					if (x.kind !== 'text' || x.href !== href) break;
					inner += runXml(x, base, style);
					i++;
				}
				out += href.startsWith('#')
					? `<w:hyperlink w:anchor="${escapeXml(href.slice(1))}" w:history="1">${inner}</w:hyperlink>`
					: `<w:hyperlink xmlns:r="${R_NS}" r:id="${this.addRel('hyperlink', href, true)}" w:history="1">${inner}</w:hyperlink>`;
			} else {
				out += r.kind === 'token' ? (r.fmt === 'docx' ? r.xml : '') : runXml(r, base, null);
				i++;
			}
		}
		return out;
	}

	async writeData(data: unknown): Promise<void> {
		const ctx = this.ctx;
		const zip = ctx.zip;
		if (data !== null && data !== undefined) {
			const itemXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<tl:throughline xmlns:tl="${ANALYSIS_URN}" version="1">${jsonForXml(data)}</tl:throughline>`;
			if (ctx.customPath && zip.has(ctx.customPath)) { zip.set(ctx.customPath, itemXml); return; }
			let n = 1;
			while (zip.has(`customXml/item${n}.xml`)) n++;
			const path = `customXml/item${n}.xml`;
			const guid = `{${crypto.randomUUID().toUpperCase()}}`;
			zip.set(path, itemXml);
			zip.set(`customXml/itemProps${n}.xml`, `<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n<ds:datastoreItem ds:itemID="${guid}" xmlns:ds="http://schemas.openxmlformats.org/officeDocument/2006/customXml"><ds:schemaRefs><ds:schemaRef ds:uri="${ANALYSIS_URN}"/></ds:schemaRefs></ds:datastoreItem>`);
			zip.set(`customXml/_rels/item${n}.xml.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL_T}customXmlProps" Target="itemProps${n}.xml"/></Relationships>`);
			this.addRel('customXml', this.relTarget(path), false);
			this.addOverride(`/customXml/itemProps${n}.xml`, 'application/vnd.openxmlformats-officedocument.customXmlProperties+xml');
			this.ensureDefault('xml', 'application/xml');
			ctx.customPath = path;
			return;
		}
		if (!ctx.customPath || !zip.has(ctx.customPath)) return;
		const path = ctx.customPath;
		const n = /item(\d+)\.xml$/.exec(path)?.[1];
		zip.delete(path);
		if (n) { zip.delete(`customXml/itemProps${n}.xml`); zip.delete(`customXml/_rels/item${n}.xml.rels`); }
		const target = this.relTarget(path);
		for (const r of this.relEls()) if (r.getAttribute('Target') === target) { r.remove(); this.dirty.add('rels'); }
		for (const o of Array.from(this.ctDoc.documentElement.children)) {
			if (n && o.getAttribute('PartName') === `/customXml/itemProps${n}.xml`) { o.remove(); this.dirty.add('ct'); }
		}
		ctx.customPath = null;
	}
}

function stripPPr(xml: string): string {
	if (!/sectPr|pPrChange/.test(xml)) return xml;
	try {
		const el = parseXml(xml).documentElement;
		for (const c of Array.from(el.children)) if (c.localName === 'sectPr' || c.localName === 'pPrChange') c.remove();
		return serializeXml(el);
	} catch { return xml; }
}

function rPrXml(base: BaseRPr | null, b: boolean, i: boolean, linkStyle: string | null): string {
	let s = linkStyle ? `<w:rStyle w:val="${escapeXml(linkStyle)}"/>` : '';
	s += base?.rFonts ?? '';
	if (b) s += '<w:b/><w:bCs/>';
	if (i) s += '<w:i/><w:iCs/>';
	for (const k of ['color', 'w', 'kern', 'sz', 'szCs'] as const) if (!(linkStyle && k === 'color')) s += base?.[k] ?? '';
	s += base?.lang ?? '';
	return s ? `<w:rPr>${s}</w:rPr>` : '';
}

function runXml(r: Extract<Run, { kind: 'text' }>, base: BaseRPr | null, linkStyle: string | null): string {
	let body = '';
	for (const p of r.t.split(/(\t|\n)/)) {
		if (p === '\t') body += '<w:tab/>';
		else if (p === '\n') body += '<w:br/>';
		else if (p) body += `<w:t xml:space="preserve">${escapeXml(p)}</w:t>`;
	}
	return body ? `<w:r>${rPrXml(base, r.b, r.i, linkStyle)}${body}</w:r>` : '';
}

function headingStyleXml(level: number, normalId: string | null): string {
	const size = [36, 30, 26][level - 1];
	const basedOn = normalId ? `<w:basedOn w:val="${escapeXml(normalId)}"/><w:next w:val="${escapeXml(normalId)}"/>` : '';
	return `<w:style xmlns:w="${W}" w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/>${basedOn}<w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="${[480, 360, 240][level - 1]}" w:after="120"/><w:outlineLvl w:val="${level - 1}"/></w:pPr><w:rPr><w:b/><w:bCs/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`;
}

function linkStyleXml(): string {
	return `<w:style xmlns:w="${W}" w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>`;
}

function abstractNumXml(kind: 'ul' | 'ol', id: string): string {
	return `<w:abstractNum xmlns:w="${W}" w:abstractNumId="${id}"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="${kind === 'ul' ? 'bullet' : 'decimal'}"/><w:lvlText w:val="${kind === 'ul' ? '\u2022' : '%1.'}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>`;
}
