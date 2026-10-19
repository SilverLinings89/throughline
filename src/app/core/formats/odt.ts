/**
 * .odt (OpenDocument text) reader and writer.
 * Same approach as the .docx codec: rebuild `<office:text>`, keep unchanged paragraphs verbatim.
 */
import type { Block, BlockType, Bytes, OdtMeta, Run, SaveBlock } from '../model';
import { mergeRuns, textRun } from '../util/runs';
import { clamp, escapeXml } from '../util/strings';
import { childElement, childElements, ensureRootNamespace, parseXml, replaceElementContent, serializeXml } from '../xml/xml';
import { ZipArchive } from '../zip/zip-archive';

const NS = {
	office: 'urn:oasis:names:tc:opendocument:xmlns:office:1.0',
	text: 'urn:oasis:names:tc:opendocument:xmlns:text:1.0',
	style: 'urn:oasis:names:tc:opendocument:xmlns:style:1.0',
	fo: 'urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0',
	xlink: 'http://www.w3.org/1999/xlink',
	draw: 'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0',
	table: 'urn:oasis:names:tc:opendocument:xmlns:table:1.0',
	manifest: 'urn:oasis:names:tc:opendocument:xmlns:manifest:1.0',
	meta: 'urn:oasis:names:tc:opendocument:xmlns:meta:1.0',
	svg: 'urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0',
} as const;

/** Package path of the analysis file inside an .odt. */
export const ODT_DATA_PATH = 'Throughline/analysis.json';

const SKIP_INLINE = new Set(['soft-page-break', 'bookmark', 'bookmark-start', 'bookmark-end', 'reference-mark', 'reference-mark-start', 'reference-mark-end', 'change', 'change-start', 'change-end', 'alphabetical-index-mark', 'alphabetical-index-mark-start', 'alphabetical-index-mark-end', 'toc-mark', 'toc-mark-start', 'toc-mark-end', 'user-index-mark', 'user-index-mark-start', 'user-index-mark-end']);

interface TextStyle { readonly b: boolean | null; readonly i: boolean | null; readonly parent: string | null }
interface ParaStyle { readonly parent: string | null; readonly outline: number | null }

export interface OdtContext {
	readonly fmt: 'odt';
	readonly zip: ZipArchive;
	contentStr: string;
	readonly textStyles: Map<string, TextStyle>;
	readonly listStyles: Map<string, 'ul' | 'ol'>;
	notes: number;
	prelude: string;
}

function textStyleValue(map: Map<string, TextStyle>, name: string | null, key: 'b' | 'i'): boolean | null {
	let s = name ? map.get(name) : undefined;
	for (let k = 0; s && k < 10; k++) {
		if (s[key] !== null) return s[key];
		s = s.parent ? map.get(s.parent) : undefined;
	}
	return null;
}

interface Fmt { b: boolean; i: boolean; href: string | null }
function readInline(node: Node, ctx: OdtContext, f: Fmt, out: Run[]): void {
	for (const c of Array.from(node.childNodes)) {
		if (c.nodeType === Node.TEXT_NODE) {
			const t = (c.nodeValue ?? '').replace(/[ \t\r\n]+/g, ' ');
			if (t) out.push(textRun(t, f));
			continue;
		}
		if (!(c instanceof Element)) continue;
		const ln = c.localName;
		if (c.namespaceURI === NS.office && (ln === 'annotation' || ln === 'annotation-end')) continue;
		if (c.namespaceURI === NS.draw) continue;
		if (c.namespaceURI === NS.text) {
			if (SKIP_INLINE.has(ln)) continue;
			if (ln === 'span') {
				const sn = c.getAttributeNS(NS.text, 'style-name');
				readInline(c, ctx, { ...f, b: textStyleValue(ctx.textStyles, sn, 'b') ?? f.b, i: textStyleValue(ctx.textStyles, sn, 'i') ?? f.i }, out);
				continue;
			}
			if (ln === 'a') { readInline(c, ctx, { ...f, href: c.getAttributeNS(NS.xlink, 'href') ?? f.href }, out); continue; }
			if (ln === 's') { out.push(textRun(' '.repeat(Math.max(1, Number(c.getAttributeNS(NS.text, 'c') ?? 1))), f)); continue; }
			if (ln === 'tab') { out.push(textRun('\t', f)); continue; }
			if (ln === 'line-break') { out.push(textRun('\n', f)); continue; }
			if (ln === 'note') { ctx.notes++; out.push({ kind: 'token', fmt: 'odt', xml: serializeXml(c), label: String(ctx.notes) }); continue; }
		}
		readInline(c, ctx, f, out);
	}
}

function readParagraph(el: Element, ctx: OdtContext, type: BlockType, listStyle: string): Block {
	const runs: Run[] = [];
	readInline(el, ctx, { b: false, i: false, href: null }, runs);
	const first = runs[0];
	if (first?.kind === 'text') runs[0] = { ...first, t: first.t.replace(/^ /, '') };
	const meta: OdtMeta = { fmt: 'odt', xml: serializeXml(el), type, styleName: el.getAttributeNS(NS.text, 'style-name') ?? '', listStyle };
	return type === 'opaque' ? { type, label: 'Content', meta } : { type, runs: mergeRuns(runs), meta };
}

const opaqueOf = (label: string, el: Element): Block => ({ type: 'opaque', label, meta: { fmt: 'odt', xml: serializeXml(el), type: 'opaque', styleName: '', listStyle: '' } });
const headingType = (level: number): BlockType => (['h1', 'h2', 'h3'] as const)[clamp(level, 1, 3) - 1];

/** Reads an .odt package. */
export async function readOdt(bytes: Bytes): Promise<{ blocks: Block[]; ctx: OdtContext; data: unknown }> {
	const zip = await ZipArchive.open(bytes);
	const mimetype = await zip.text('mimetype');
	if (mimetype && !mimetype.includes('opendocument.text')) throw new Error('This OpenDocument file is not a text document.');
	const contentStr = await zip.text('content.xml');
	if (!contentStr) throw new Error('The .odt file has no content.xml.');
	const doc = parseXml(contentStr);
	const stylesXml = await zip.text('styles.xml');
	const sdoc = stylesXml ? parseXml(stylesXml) : null;
	const textStyles = new Map<string, TextStyle>();
	const paraStyles = new Map<string, ParaStyle>();
	const listStyles = new Map<string, 'ul' | 'ol'>();
	for (const d of [sdoc, doc]) {
		if (!d) continue;
		for (const s of Array.from(d.getElementsByTagNameNS(NS.style, 'style'))) {
			const family = s.getAttributeNS(NS.style, 'family');
			const name = s.getAttributeNS(NS.style, 'name') ?? '';
			const parent = s.getAttributeNS(NS.style, 'parent-style-name');
			if (family === 'paragraph') {
				const ol = s.getAttributeNS(NS.style, 'default-outline-level');
				paraStyles.set(name, { parent, outline: ol ? Number(ol) : null });
			} else if (family === 'text') {
				const tp = childElement(s, 'text-properties');
				const fw = tp?.getAttributeNS(NS.fo, 'font-weight') ?? null;
				const fs = tp?.getAttributeNS(NS.fo, 'font-style') ?? null;
				textStyles.set(name, { b: fw ? fw === 'bold' || Number(fw) >= 600 : null, i: fs ? fs === 'italic' || fs === 'oblique' : null, parent });
			}
		}
		for (const l of Array.from(d.getElementsByTagNameNS(NS.text, 'list-style'))) {
			listStyles.set(l.getAttributeNS(NS.style, 'name') ?? '', /number/.test(l.firstElementChild?.localName ?? '') ? 'ol' : 'ul');
		}
	}
	const headingFromStyle = (name: string | null): number => {
		let n = name;
		for (let k = 0; n && k < 10; k++) {
			const m = /^Heading_20_(\d)$/.exec(n);
			if (m) return Number(m[1]);
			if (n === 'Title') return 1;
			const st = paraStyles.get(n);
			if (!st) return 0;
			if (st.outline) return st.outline;
			n = st.parent;
		}
		return 0;
	};
	const officeText = doc.getElementsByTagNameNS(NS.office, 'text')[0];
	if (!officeText) throw new Error('No text body was found in this .odt file.');
	const ctx: OdtContext = { fmt: 'odt', zip, contentStr, textStyles, listStyles, notes: 0, prelude: '' };
	const blocks: Block[] = [];
	const readList = (list: Element, inherited: 'ul' | 'ol' | null): void => {
		const sn = list.getAttributeNS(NS.text, 'style-name');
		const kind = (sn ? listStyles.get(sn) : undefined) ?? inherited ?? 'ul';
		for (const item of childElements(list)) {
			if (item.localName !== 'list-item' && item.localName !== 'list-header') continue;
			for (const c of childElements(item)) {
				if (c.localName === 'p' || c.localName === 'h') blocks.push(readParagraph(c, ctx, kind, sn ?? ''));
				else if (c.localName === 'list') readList(c, kind);
			}
		}
	};
	const walk = (parent: Element): void => {
		for (const el of childElements(parent)) {
			const ln = el.localName;
			const isText = el.namespaceURI === NS.text;
			if (isText && ln === 'h') blocks.push(readParagraph(el, ctx, headingType(Number(el.getAttributeNS(NS.text, 'outline-level') ?? 1)), ''));
			else if (isText && ln === 'p') {
				if (el.getElementsByTagNameNS(NS.draw, '*').length) { blocks.push(opaqueOf('Image', el)); continue; }
				const level = headingFromStyle(el.getAttributeNS(NS.text, 'style-name'));
				blocks.push(readParagraph(el, ctx, level ? headingType(level) : 'p', ''));
			} else if (isText && ln === 'list') readList(el, null);
			else if (isText && ln === 'section') walk(el);
			else if (isText && ln === 'soft-page-break') continue;
			else if (/-decls$/.test(ln) || ln === 'forms' || ln === 'calculation-settings' || ln === 'tracked-changes') ctx.prelude += serializeXml(el);
			else blocks.push(opaqueOf(ln === 'table' ? 'Table' : ln === 'table-of-content' ? 'Table of contents' : 'Embedded content', el));
		}
	};
	walk(officeText);
	let data: unknown = null;
	const dataText = await zip.text(ODT_DATA_PATH);
	if (dataText) { try { data = JSON.parse(dataText); } catch { data = null; } }
	return { blocks, ctx, data };
}

/** Builds an empty .odt and returns its context. */
export async function blankOdt(): Promise<OdtContext> {
	const z = new ZipArchive();
	const ns = `xmlns:office="${NS.office}" xmlns:style="${NS.style}" xmlns:text="${NS.text}" xmlns:fo="${NS.fo}" xmlns:xlink="${NS.xlink}" xmlns:table="${NS.table}" xmlns:draw="${NS.draw}" xmlns:svg="${NS.svg}"`;
	z.set('mimetype', 'application/vnd.oasis.opendocument.text');
	z.set('META-INF/manifest.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<manifest:manifest xmlns:manifest="${NS.manifest}" manifest:version="1.3"><manifest:file-entry manifest:full-path="/" manifest:version="1.3" manifest:media-type="application/vnd.oasis.opendocument.text"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/></manifest:manifest>`);
	z.set('meta.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<office:document-meta xmlns:office="${NS.office}" xmlns:meta="${NS.meta}" office:version="1.3"><office:meta><meta:generator>Throughline</meta:generator></office:meta></office:document-meta>`);
	const headings = [1, 2, 3].map(n => `<style:style style:name="Heading_20_${n}" style:display-name="Heading ${n}" style:family="paragraph" style:parent-style-name="Heading" style:next-style-name="Text_20_body" style:default-outline-level="${n}" style:class="text"><style:text-properties fo:font-size="${[18, 15, 13][n - 1]}pt" fo:font-weight="bold"/></style:style>`).join('');
	z.set('styles.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<office:document-styles ${ns} office:version="1.3"><office:font-face-decls><style:font-face style:name="Georgia" svg:font-family="Georgia" style:font-family-generic="roman"/></office:font-face-decls><office:styles><style:default-style style:family="paragraph"><style:text-properties style:font-name="Georgia" fo:font-size="12pt"/></style:default-style><style:style style:name="Standard" style:family="paragraph" style:class="text"><style:paragraph-properties fo:margin-top="0cm" fo:margin-bottom="0.28cm" fo:line-height="125%"/></style:style><style:style style:name="Text_20_body" style:display-name="Text body" style:family="paragraph" style:parent-style-name="Standard" style:class="text"/><style:style style:name="Heading" style:family="paragraph" style:parent-style-name="Standard" style:next-style-name="Text_20_body" style:class="text"><style:paragraph-properties fo:margin-top="0.6cm" fo:margin-bottom="0.25cm" fo:keep-with-next="always"/><style:text-properties fo:font-weight="bold"/></style:style>${headings}</office:styles><office:automatic-styles><style:page-layout style:name="pm1"><style:page-layout-properties fo:page-width="21.001cm" fo:page-height="29.7cm" fo:margin-top="2.5cm" fo:margin-bottom="2.5cm" fo:margin-left="2.5cm" fo:margin-right="2.5cm"/></style:page-layout></office:automatic-styles><office:master-styles><style:master-page style:name="Standard" style:page-layout-name="pm1"/></office:master-styles></office:document-styles>`);
	z.set('content.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<office:document-content ${ns} office:version="1.3"><office:automatic-styles/><office:body><office:text></office:text></office:body></office:document-content>`);
	return (await readOdt(await z.build())).ctx;
}

const AUTO_STYLES: Record<string, string> = {
	TL_b: '<style:style style:name="TL_b" style:family="text"><style:text-properties fo:font-weight="bold" style:font-weight-asian="bold" style:font-weight-complex="bold"/></style:style>',
	TL_i: '<style:style style:name="TL_i" style:family="text"><style:text-properties fo:font-style="italic" style:font-style-asian="italic" style:font-style-complex="italic"/></style:style>',
	TL_bi: '<style:style style:name="TL_bi" style:family="text"><style:text-properties fo:font-weight="bold" style:font-weight-asian="bold" style:font-weight-complex="bold" fo:font-style="italic" style:font-style-asian="italic" style:font-style-complex="italic"/></style:style>',
	TL_ul: '<text:list-style style:name="TL_ul"><text:list-level-style-bullet text:level="1" text:bullet-char="\u2022"><style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="listtab" text:list-tab-stop-position="0.635cm" fo:text-indent="-0.635cm" fo:margin-left="0.635cm"/></style:list-level-properties></text:list-level-style-bullet></text:list-style>',
	TL_ol: '<text:list-style style:name="TL_ol"><text:list-level-style-number text:level="1" style:num-suffix="." style:num-format="1"><style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="listtab" text:list-tab-stop-position="0.635cm" fo:text-indent="-0.635cm" fo:margin-left="0.635cm"/></style:list-level-properties></text:list-level-style-number></text:list-style>',
};

function runXml(r: Run, used: Set<string>): string {
	if (r.kind === 'token') return r.fmt === 'odt' ? r.xml : '';
	let s = '';
	for (const part of r.t.split(/(\t|\n)/)) {
		if (part === '\t') s += '<text:tab/>';
		else if (part === '\n') s += '<text:line-break/>';
		else if (part) s += escapeXml(part).replace(/ {2,}/g, m => ` <text:s text:c="${m.length - 1}"/>`).replace(/^ /, '<text:s/>');
	}
	const style = r.b && r.i ? 'TL_bi' : r.b ? 'TL_b' : r.i ? 'TL_i' : null;
	if (style && s) { used.add(style); s = `<text:span text:style-name="${style}">${s}</text:span>`; }
	return s;
}

function runsXml(runs: readonly Run[], used: Set<string>): string {
	let out = '';
	let i = 0;
	while (i < runs.length) {
		const r = runs[i];
		if (r.kind === 'text' && r.href) {
			const href = r.href;
			let inner = '';
			while (i < runs.length) {
				const x = runs[i];
				if (x.kind !== 'text' || x.href !== href) break;
				inner += runXml(x, used);
				i++;
			}
			out += `<text:a xlink:type="simple" xlink:href="${escapeXml(href)}">${inner}</text:a>`;
		} else { out += runXml(r, used); i++; }
	}
	return out;
}

/** Writes blocks into the package held by `ctx`. `data` goes to `Throughline/analysis.json`. */
export async function writeOdt(blocks: readonly SaveBlock[], ctx: OdtContext, data: unknown): Promise<Bytes> {
	const used = new Set<string>();
	const counts = new Map<string, number>();
	for (const b of blocks) if (b.meta?.fmt === 'odt' && b.meta.type === 'p' && b.meta.styleName) counts.set(b.meta.styleName, (counts.get(b.meta.styleName) ?? 0) + 1);
	const bodyStyle = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'Standard';
	const nearestStyle = (k: number, type: BlockType): string | null => {
		for (let d = 1; d < blocks.length; d++) for (const j of [k - d, k + d]) {
			const m = blocks[j]?.meta;
			if (m && m.fmt === 'odt' && m.type === type && m.styleName) return m.styleName;
		}
		return null;
	};
	const parts: string[] = [ctx.prelude];
	let list: { kind: 'ul' | 'ol'; style: string } | null = null;
	const closeList = (): void => { if (list) { parts.push('</text:list>'); list = null; } };
	blocks.forEach((b, k) => {
		const m = b.meta?.fmt === 'odt' ? b.meta : null;
		if (b.type === 'ul' || b.type === 'ol') {
			const own = m && m.type === b.type && m.listStyle ? m.listStyle : null;
			if (!list || list.kind !== b.type || (own && own !== list.style)) {
				closeList();
				const style = own ?? `TL_${b.type}`;
				if (!own) used.add(style);
				parts.push(`<text:list text:style-name="${escapeXml(style)}">`);
				list = { kind: b.type, style };
			}
			const inner = b.unchanged && m ? m.xml
				: `<text:p text:style-name="${escapeXml((m && m.type === b.type && m.styleName) || nearestStyle(k, b.type) || bodyStyle)}">${runsXml(b.runs, used)}</text:p>`;
			parts.push(`<text:list-item>${inner}</text:list-item>`);
			return;
		}
		closeList();
		if (b.type === 'opaque') { if (m) parts.push(m.xml); return; }
		if (b.unchanged && m) { parts.push(m.xml); return; }
		if (b.type === 'h1' || b.type === 'h2' || b.type === 'h3') {
			const level = Number(b.type[1]);
			const sn = (m && m.type === b.type && m.styleName) || nearestStyle(k, b.type) || `Heading_20_${level}`;
			parts.push(`<text:h text:style-name="${escapeXml(sn)}" text:outline-level="${level}">${runsXml(b.runs, used)}</text:h>`);
		} else {
			const sn = (m && m.type === 'p' && m.styleName) || nearestStyle(k, 'p') || bodyStyle;
			parts.push(`<text:p text:style-name="${escapeXml(sn)}">${runsXml(b.runs, used)}</text:p>`);
		}
	});
	closeList();
	let xml = replaceElementContent(ctx.contentStr, 'office:text', parts.join(''));
	let add = '';
	for (const n of used) if (!xml.includes(`style:name="${n}"`)) add += AUTO_STYLES[n] ?? '';
	if (add) {
		if (/<office:automatic-styles\s*\/>/.test(xml)) xml = xml.replace(/<office:automatic-styles\s*\/>/, `<office:automatic-styles>${add}</office:automatic-styles>`);
		else if (xml.includes('</office:automatic-styles>')) xml = xml.replace('</office:automatic-styles>', `${add}</office:automatic-styles>`);
		else xml = xml.replace(/<office:body/, `<office:automatic-styles>${add}</office:automatic-styles><office:body`);
	}
	for (const [prefix, uri] of [['text', NS.text], ['xlink', NS.xlink], ['style', NS.style], ['fo', NS.fo]] as const) xml = ensureRootNamespace(xml, prefix, uri);
	ctx.zip.set('content.xml', xml);
	ctx.contentStr = xml;
	const manifest = await ctx.zip.text('META-INF/manifest.xml');
	if (data !== null && data !== undefined) {
		ctx.zip.set(ODT_DATA_PATH, JSON.stringify(data));
		if (manifest && !manifest.includes(`"${ODT_DATA_PATH}"`)) {
			ctx.zip.set('META-INF/manifest.xml', manifest.replace('</manifest:manifest>', `<manifest:file-entry manifest:full-path="${ODT_DATA_PATH}" manifest:media-type="application/json"/></manifest:manifest>`));
		}
	} else if (ctx.zip.has(ODT_DATA_PATH)) {
		ctx.zip.delete(ODT_DATA_PATH);
		if (manifest) ctx.zip.set('META-INF/manifest.xml', manifest.replace(/<manifest:file-entry[^>]*full-path="Throughline\/analysis\.json"[^>]*\/>/, ''));
	}
	return ctx.zip.build();
}
