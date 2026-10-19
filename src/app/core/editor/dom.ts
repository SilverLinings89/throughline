/**
 * DOM work for the contenteditable editor: rendering blocks, reading them back,
 * mapping text offsets to ranges, and keeping the DOM to the small block set the app supports.
 *
 * Framework-free on purpose: the editor DOM is owned by the browser's editing engine,
 * not by Angular templates. Every function takes the editor root explicitly.
 */
import type { Block, BlockType, ListType, Run, TextBlockType } from '../model';
import { mergeRuns, textRun } from '../util/runs';
import { escapeHtml } from '../util/strings';

const ROOT_BLOCKS = new Set(['P', 'H1', 'H2', 'H3', 'UL', 'OL']);
const BLOCKISH = /^(DIV|H4|H5|H6|BLOCKQUOTE|PRE|SECTION|ARTICLE|HEADER|FOOTER)$/;

/** Block type of an editor element. */
export function typeOf(el: Element): BlockType {
	switch (el.tagName) {
		case 'LI': return el.parentElement?.tagName === 'OL' ? 'ol' : 'ul';
		case 'H1': return 'h1';
		case 'H2': return 'h2';
		case 'H3': return 'h3';
		default: return el.classList.contains('opaque') ? 'opaque' : 'p';
	}
}

/** Block elements in document order: root children, with list items in place of their lists. */
export function blockElements(root: HTMLElement): HTMLElement[] {
	const out: HTMLElement[] = [];
	for (const c of Array.from(root.children)) {
		if (!(c instanceof HTMLElement)) continue;
		if (c.tagName === 'UL' || c.tagName === 'OL') {
			for (const li of Array.from(c.children)) if (li instanceof HTMLElement && li.tagName === 'LI') out.push(li);
		} else out.push(c);
	}
	return out;
}

/** Appends runs to an element as text, `<br>`, `<b>`, `<i>`, `<a>` and token markers. */
export function renderRuns(target: HTMLElement, runs: readonly Run[]): void {
	const doc = target.ownerDocument;
	for (const r of runs) {
		if (r.kind === 'token') {
			const s = doc.createElement('sup');
			s.className = 'tok';
			s.contentEditable = 'false';
			s.dataset['x'] = r.xml;
			s.dataset['fmt'] = r.fmt;
			s.textContent = r.label;
			s.title = 'Note reference, kept from the file';
			target.appendChild(s);
			continue;
		}
		let node: Node = doc.createDocumentFragment();
		r.t.split('\n').forEach((part, i) => {
			if (i) node.appendChild(doc.createElement('br'));
			if (part) node.appendChild(doc.createTextNode(part));
		});
		if (r.i) { const e = doc.createElement('i'); e.appendChild(node); node = e; }
		if (r.b) { const e = doc.createElement('b'); e.appendChild(node); node = e; }
		if (r.href) { const a = doc.createElement('a'); a.setAttribute('href', r.href); a.appendChild(node); node = a; }
		target.appendChild(node);
	}
}

/**
 * Renders blocks into an empty root. `ids` supplies a block id per block, in order.
 * Lists are grouped into `<ul>`/`<ol>`; kept items become non-editable placeholders.
 */
export function renderBlocks(root: HTMLElement, blocks: readonly Block[], ids: readonly string[]): void {
	const doc = root.ownerDocument;
	const frag = doc.createDocumentFragment();
	let list: HTMLElement | null = null;
	blocks.forEach((b, k) => {
		let el: HTMLElement;
		if (b.type === 'ul' || b.type === 'ol') {
			if (!list || list.tagName.toLowerCase() !== b.type) { list = doc.createElement(b.type); frag.appendChild(list); }
			el = doc.createElement('li');
			list.appendChild(el);
		} else {
			list = null;
			if (b.type === 'opaque') {
				el = doc.createElement('div');
				el.className = 'opaque';
				el.contentEditable = 'false';
				el.textContent = `${b.label}, kept as it is in the file`;
			} else el = doc.createElement(b.type);
			frag.appendChild(el);
		}
		el.dataset['bid'] = ids[k];
		if (b.type !== 'opaque') renderRuns(el, b.runs);
		if (!el.firstChild) el.appendChild(doc.createElement('br'));
	});
	root.replaceChildren(frag);
}

function isTrailingBr(br: Node, block: Node): boolean {
	for (let n: Node | null = br; n && n !== block; n = n.parentNode) {
		for (let s = n.nextSibling; s; s = s.nextSibling) if (s.nodeType !== Node.TEXT_NODE || (s.nodeValue ?? '').length) return false;
	}
	return true;
}

/** Reads an editor block back into runs. A trailing `<br>` placeholder is ignored. */
export function domRuns(block: HTMLElement): Run[] {
	const out: Run[] = [];
	const walk = (node: Node, f: { b: boolean; i: boolean; href: string | null }): void => {
		for (const c of Array.from(node.childNodes)) {
			if (c.nodeType === Node.TEXT_NODE) {
				const t = (c.nodeValue ?? '').replace(/\u200B/g, '');
				if (t) out.push(textRun(t, f));
				continue;
			}
			if (!(c instanceof HTMLElement)) continue;
			if (c.tagName === 'BR') { if (!isTrailingBr(c, block)) out.push(textRun('\n', f)); continue; }
			if (c.classList.contains('tok')) {
				const fmt = c.dataset['fmt'] === 'odt' ? 'odt' : 'docx';
				out.push({ kind: 'token', fmt, xml: c.dataset['x'] ?? '', label: c.textContent ?? '' });
				continue;
			}
			const nf = { ...f };
			if (c.tagName === 'B' || c.tagName === 'STRONG') nf.b = true;
			else if (c.tagName === 'I' || c.tagName === 'EM') nf.i = true;
			else if (c.tagName === 'A') nf.href = c.getAttribute('href') ?? f.href;
			const fw = c.style.fontWeight;
			const fs = c.style.fontStyle;
			if (fw) nf.b = fw === 'bold' || Number(fw) >= 600;
			if (fs) nf.i = fs === 'italic' || fs === 'oblique';
			walk(c, nf);
		}
	};
	walk(block, { b: false, i: false, href: null });
	return mergeRuns(out);
}

/** A string that changes whenever a block's type, text or formatting changes. */
export function signature(type: BlockType, runs: readonly Run[]): string {
	return `${type}|${JSON.stringify(runs)}`;
}

/** Text nodes of a block, excluding token markers. */
export function textNodes(block: Node): Text[] {
	const out: Text[] = [];
	const tw = block.ownerDocument!.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
		acceptNode: n => (n.parentElement?.closest('.tok') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
	});
	for (let n = tw.nextNode(); n; n = tw.nextNode()) if (n instanceof Text) out.push(n);
	return out;
}

/** Text of a block as the analysis sees it: no token labels, `<br>` not counted. */
export function blockText(block: HTMLElement): string {
	return block.querySelector('.tok') ? textNodes(block).map(n => n.data).join('') : block.textContent ?? '';
}

/** Converts a DOM position inside `block` to a text offset as counted by `blockText`. */
export function offsetOf(block: HTMLElement, node: Node, offset: number): number {
	let acc = 0;
	if (node.nodeType === Node.TEXT_NODE) {
		for (const t of textNodes(block)) { if (t === node) return acc + offset; acc += t.data.length; }
		return acc;
	}
	const ref = node.childNodes[offset] ?? null;
	for (const t of textNodes(block)) {
		if (ref) { if (ref === t || ref.contains(t) || t.compareDocumentPosition(ref) & Node.DOCUMENT_POSITION_PRECEDING) break; }
		else if (!(node.contains(t) || t.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)) break;
		acc += t.data.length;
	}
	return acc;
}

/** A live DOM range over text offsets `start`..`end` of a block. */
export function rangeFor(block: HTMLElement, start: number, end: number): Range {
	const r = block.ownerDocument.createRange();
	const nodes = textNodes(block);
	if (!nodes.length) { r.setStart(block, 0); r.collapse(true); return r; }
	let acc = 0;
	let set = false;
	for (const t of nodes) {
		const len = t.data.length;
		if (!set && start <= acc + len) { r.setStart(t, start - acc); set = true; }
		if (set && end <= acc + len) { r.setEnd(t, Math.max(end - acc, r.startContainer === t ? r.startOffset : 0)); return r; }
		acc += len;
	}
	const last = nodes[nodes.length - 1];
	if (!set) r.setStart(last, last.data.length);
	r.setEnd(last, last.data.length);
	return r;
}

/** The block element that contains `node`, or null outside the editor. */
export function blockOf(root: HTMLElement, node: Node | null): HTMLElement | null {
	let n: Node | null = node && node.nodeType === Node.TEXT_NODE ? node.parentNode : node;
	while (n && n !== root) {
		const p: Node | null = n.parentNode;
		if (p === root && n instanceof HTMLElement) return n.tagName === 'UL' || n.tagName === 'OL' ? n.querySelector('li') : n;
		if (n instanceof HTMLElement && n.tagName === 'LI' && p?.parentNode === root) return n;
		n = p;
	}
	return null;
}

/** Text offset of the selection focus inside `block`, or 0. */
export function caretOffset(block: HTMLElement): number {
	const s = block.ownerDocument.getSelection();
	return s && s.rangeCount && s.focusNode && block.contains(s.focusNode) ? offsetOf(block, s.focusNode, s.focusOffset) : 0;
}

export function selectRange(r: Range): void {
	const s = r.startContainer.ownerDocument?.getSelection();
	if (!s) return;
	s.removeAllRanges();
	s.addRange(r);
}

function isRootBlock(n: Node): boolean {
	return n instanceof HTMLElement && (ROOT_BLOCKS.has(n.tagName) || n.classList.contains('opaque'));
}

/**
 * Repairs the editor DOM after browser editing: wraps stray inline content in paragraphs,
 * turns `<div>` and `<h4>`–`<h6>` into supported blocks, flattens blocks nested in paragraphs,
 * and merges neighbouring lists of the same type. Keeps the selection. Returns true when it changed something.
 */
export function normalizeEditor(root: HTMLElement): boolean {
	const doc = root.ownerDocument;
	const sel = doc.getSelection();
	const saved = sel && sel.rangeCount ? [sel.anchorNode, sel.anchorOffset, sel.focusNode, sel.focusOffset] as const : null;
	let changed = false;
	for (let pass = 0, again = true; again && pass < 4; pass++) {
		again = false;
		for (const n of Array.from(root.childNodes)) {
			if (n.parentNode !== root) continue;
			if (n instanceof HTMLElement && n.classList.contains('opaque')) continue;
			if (n instanceof HTMLElement && /^(P|H1|H2|H3)$/.test(n.tagName) && Array.from(n.children).some(c => ROOT_BLOCKS.has(c.tagName) || BLOCKISH.test(c.tagName) || c.tagName === 'LI')) {
				let cur: HTMLElement | null = null;
				let first = true;
				for (const c of Array.from(n.childNodes)) {
					if (c instanceof HTMLElement && (ROOT_BLOCKS.has(c.tagName) || BLOCKISH.test(c.tagName))) { n.before(c); cur = null; continue; }
					if (c instanceof HTMLElement && c.tagName === 'LI') { const l = doc.createElement('ul'); l.appendChild(c); n.before(l); cur = null; continue; }
					if (c.nodeType === Node.TEXT_NODE && !(c.nodeValue ?? '').trim() && !cur) { c.remove(); continue; }
					if (!cur) {
						cur = doc.createElement(n.tagName);
						if (first && n.dataset['bid']) cur.dataset['bid'] = n.dataset['bid'];
						first = false;
						n.before(cur);
					}
					cur.appendChild(c);
				}
				n.remove();
				changed = again = true;
				continue;
			}
			if (n instanceof HTMLElement && ROOT_BLOCKS.has(n.tagName)) {
				if (n.tagName === 'UL' || n.tagName === 'OL') {
					for (const c of Array.from(n.childNodes)) {
						if (c instanceof HTMLElement && c.tagName === 'LI') continue;
						if (c.nodeType === Node.TEXT_NODE && !(c.nodeValue ?? '').trim()) { c.remove(); continue; }
						const li = doc.createElement('li');
						c.before(li);
						li.appendChild(c);
						changed = true;
					}
					if (!n.querySelector('li')) { n.remove(); changed = true; }
				}
				continue;
			}
			if (n.nodeType === Node.TEXT_NODE && !(n.nodeValue ?? '').trim()) { n.remove(); changed = true; continue; }
			if (n instanceof HTMLElement && BLOCKISH.test(n.tagName)) {
				const p = doc.createElement(/^H[456]$/.test(n.tagName) ? 'h3' : 'p');
				if (n.dataset['bid']) p.dataset['bid'] = n.dataset['bid'];
				while (n.firstChild) p.appendChild(n.firstChild);
				n.replaceWith(p);
				changed = true;
				continue;
			}
			if (n instanceof HTMLElement && n.tagName === 'BR') { n.remove(); changed = true; continue; }
			if (n.nodeType !== Node.ELEMENT_NODE && n.nodeType !== Node.TEXT_NODE) { n.remove(); continue; }
			const p = doc.createElement('p');
			n.before(p);
			let c: Node | null = n;
			while (c && !(isRootBlock(c) || (c instanceof HTMLElement && (BLOCKISH.test(c.tagName) || c.tagName === 'BR')))) {
				const next: Node | null = c.nextSibling;
				p.appendChild(c);
				c = next;
			}
			changed = true;
		}
	}
	for (const l of Array.from(root.querySelectorAll(':scope > ul + ul, :scope > ol + ol'))) {
		const prev = l.previousElementSibling;
		if (!prev) continue;
		while (l.firstChild) prev.appendChild(l.firstChild);
		l.remove();
		changed = true;
	}
	if (!root.firstElementChild) {
		const p = doc.createElement('p');
		p.appendChild(doc.createElement('br'));
		root.appendChild(p);
		changed = true;
	}
	if (changed && saved && saved[0]?.isConnected && saved[2]?.isConnected) {
		try { sel?.setBaseAndExtent(saved[0], saved[1], saved[2], saved[3]); } catch { /* the selection pointed into removed nodes */ }
	}
	return changed;
}

/** Blocks touched by the selection, kept items excluded. */
export function selectedBlocks(root: HTMLElement): HTMLElement[] {
	const s = root.ownerDocument.getSelection();
	if (!s || !s.rangeCount) return [];
	const r = s.getRangeAt(0);
	const all = blockElements(root);
	let i = all.indexOf(blockOf(root, r.startContainer) ?? root);
	let j = all.indexOf(blockOf(root, r.endContainer) ?? root);
	if (i < 0 && j < 0) return [];
	if (i < 0) i = j;
	if (j < 0) j = i;
	return all.slice(Math.min(i, j), Math.max(i, j) + 1).filter(e => !e.classList.contains('opaque'));
}

function retag(el: HTMLElement, tag: string): HTMLElement {
	if (el.tagName.toLowerCase() === tag) return el;
	const n = el.ownerDocument.createElement(tag);
	for (const a of Array.from(el.attributes)) n.setAttribute(a.name, a.value);
	while (el.firstChild) n.appendChild(el.firstChild);
	el.replaceWith(n);
	return n;
}

function liftOutOfList(li: HTMLElement): HTMLElement {
	const list = li.parentElement;
	if (!list) return li;
	const after: Node[] = [];
	for (let n = li.nextSibling; n; n = n.nextSibling) after.push(n);
	const p = retag(li, 'p');
	list.after(p);
	if (after.length) {
		const rest = list.ownerDocument.createElement(list.tagName);
		after.forEach(x => rest.appendChild(x));
		p.after(rest);
	}
	if (!list.querySelector('li')) list.remove();
	return p;
}

function mergeLists(list: HTMLElement): void {
	let l = list;
	const prev = l.previousElementSibling;
	if (prev instanceof HTMLElement && prev.tagName === l.tagName) { while (l.firstChild) prev.appendChild(l.firstChild); l.remove(); l = prev; }
	const next = l.nextElementSibling;
	if (next && next.tagName === l.tagName) { while (next.firstChild) l.appendChild(next.firstChild); next.remove(); }
}

/**
 * Changes the type of the selected blocks. Headings and paragraphs use the browser's undoable
 * `formatBlock`. Lists are built in the DOM directly, because Chrome nests lists inside paragraphs.
 */
export function setBlockType(root: HTMLElement, type: TextBlockType): void {
	const doc = root.ownerDocument;
	let els = selectedBlocks(root);
	if (!els.length) return;
	const listInvolved = type === 'ul' || type === 'ol' || els.some(e => e.tagName === 'LI');
	if (!listInvolved) { doc.execCommand('formatBlock', false, `<${type}>`); return; }
	const s = doc.getSelection();
	const saved = s && s.rangeCount ? [s.anchorNode, s.anchorOffset, s.focusNode, s.focusOffset] as const : null;
	if (type === 'ul' || type === 'ol') {
		if (els.every(e => e.tagName === 'LI' && e.parentElement?.tagName.toLowerCase() === type)) return;
		els = els.map(e => (e.tagName === 'LI' ? liftOutOfList(e) : e));
		const list = doc.createElement(type);
		els[0].before(list);
		for (const e of els) list.appendChild(retag(e, 'li'));
		mergeLists(list);
	} else {
		for (const e of els) retag(e.tagName === 'LI' ? liftOutOfList(e) : e, type);
	}
	if (saved && saved[0]?.isConnected && saved[2]?.isConnected) { try { s?.setBaseAndExtent(saved[0], saved[1], saved[2], saved[3]); } catch { /* ignore */ } }
	root.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * Markdown-style shortcuts at the start of a paragraph: `# `, `## `, `### `, `- `, `* `, `1. `.
 * Call after a space was typed. Returns true when it converted the block.
 */
export function applyShortcut(root: HTMLElement): boolean {
	const s = root.ownerDocument.getSelection();
	if (!s || !s.rangeCount || !s.isCollapsed) return false;
	const b = blockOf(root, s.focusNode);
	if (!b || b.tagName !== 'P') return false;
	const off = caretOffset(b);
	const m = /^(#{1,3}|[-*]|1[.)]) $/.exec(blockText(b).slice(0, off));
	if (!m) return false;
	selectRange(rangeFor(b, 0, off));
	root.ownerDocument.execCommand('delete');
	const k = m[1];
	const type: TextBlockType = k === '#' ? 'h1' : k === '##' ? 'h2' : k === '###' ? 'h3' : k === '-' || k === '*' ? 'ul' : 'ol';
	setBlockType(root, type);
	return true;
}

/* ---------- paste ---------- */

const PASTE_BLOCK = /^(P|DIV|H[1-6]|LI|UL|OL|BLOCKQUOTE|PRE|TABLE|TBODY|THEAD|TR|TD|TH|SECTION|ARTICLE|HEADER|FOOTER|DL|DT|DD|FIGURE|FIGCAPTION|HR|MAIN|ASIDE|NAV)$/;
const PASTE_SKIP = /^(STYLE|SCRIPT|META|LINK|TITLE|HEAD|TEMPLATE|NOSCRIPT|IMG|SVG|VIDEO|AUDIO|IFRAME|OBJECT)$/;

/** Converts pasted HTML (Word, Google Docs, web pages) into supported blocks. */
export function htmlToBlocks(html: string): Block[] {
	const doc = new DOMParser().parseFromString(html, 'text/html');
	const blocks: Block[] = [];
	let cur: { type: TextBlockType; runs: Run[] } | null = null;
	const flush = (): void => {
		if (cur && cur.runs.some(r => r.kind === 'text' && r.t.trim())) {
			const runs = mergeRuns(cur.runs);
			const first = runs[0];
			if (first?.kind === 'text') runs[0] = { ...first, t: first.t.replace(/^\s+/, '') };
			blocks.push({ type: cur.type, runs, meta: null });
		}
		cur = null;
	};
	const walk = (node: Node, f: { b: boolean; i: boolean; href: string | null }, kind: ListType | null): void => {
		for (const c of Array.from(node.childNodes)) {
			if (c.nodeType === Node.TEXT_NODE) {
				const t = (c.nodeValue ?? '').replace(/\s+/g, ' ');
				if (!t) continue;
				if (!cur) { if (!t.trim()) continue; cur = { type: 'p', runs: [] }; }
				cur.runs.push(textRun(t, f));
				continue;
			}
			if (!(c instanceof Element)) continue;
			const tag = c.tagName;
			const style = c.getAttribute('style') ?? '';
			if (PASTE_SKIP.test(tag) || /mso-list:\s*ignore/i.test(style)) continue;
			if (tag === 'BR') { if (cur) cur.runs.push(textRun('\n', f)); continue; }
			if (PASTE_BLOCK.test(tag)) {
				flush();
				const nextKind: ListType | null = tag === 'UL' ? 'ul' : tag === 'OL' ? 'ol' : kind;
				if (tag !== 'UL' && tag !== 'OL' && !/^(TABLE|TBODY|THEAD|TR)$/.test(tag)) {
					const type: TextBlockType = /^H[1-6]$/.test(tag) ? (tag === 'H1' ? 'h1' : tag === 'H2' ? 'h2' : 'h3') : tag === 'LI' ? kind ?? 'ul' : 'p';
					cur = { type, runs: [] };
				}
				walk(c, f, nextKind);
				flush();
				continue;
			}
			const nf = { ...f };
			if (tag === 'B' || tag === 'STRONG' || /font-weight:\s*(bold|[6-9]00)/i.test(style)) nf.b = true;
			if (/font-weight:\s*(normal|[1-5]00)/i.test(style)) nf.b = false;
			if (tag === 'I' || tag === 'EM' || /font-style:\s*italic/i.test(style)) nf.i = true;
			if (tag === 'A') { const h = c.getAttribute('href'); if (h && !/^\s*(javascript|data):/i.test(h)) nf.href = h; }
			walk(c, nf, kind);
		}
	};
	walk(doc.body, { b: false, i: false, href: null }, null);
	flush();
	return blocks;
}

export function runsToHtml(runs: readonly Run[]): string {
	return runs.map(r => {
		if (r.kind === 'token') return '';
		let s = escapeHtml(r.t).replace(/\n/g, '<br>');
		if (r.i) s = `<i>${s}</i>`;
		if (r.b) s = `<b>${s}</b>`;
		if (r.href) s = `<a href="${escapeHtml(r.href)}">${s}</a>`;
		return s;
	}).join('');
}

export function blocksToHtml(blocks: readonly Block[]): string {
	let html = '';
	let list: ListType | null = null;
	for (const b of blocks) {
		if (b.type === 'opaque') continue;
		if (b.type === 'ul' || b.type === 'ol') {
			if (list !== b.type) { if (list) html += `</${list}>`; html += `<${b.type}>`; list = b.type; }
			html += `<li>${runsToHtml(b.runs)}</li>`;
		} else {
			if (list) { html += `</${list}>`; list = null; }
			html += `<${b.type}>${runsToHtml(b.runs)}</${b.type}>`;
		}
	}
	if (list) html += `</${list}>`;
	return html;
}

/** Inserts clipboard content: structure and basic formatting kept, everything else dropped. */
export function paste(root: HTMLElement, data: DataTransfer, splitText: (s: string) => string[]): void {
	const doc = root.ownerDocument;
	const html = data.getData('text/html');
	const text = data.getData('text/plain');
	let blocks: Block[] = html ? htmlToBlocks(html) : [];
	if (!blocks.length && text.includes('\n')) blocks = splitText(text).map(p => ({ type: 'p', runs: [textRun(p)], meta: null }));
	if (!blocks.length) { if (text) doc.execCommand('insertText', false, text); return; }
	const only = blocks[0];
	if (blocks.length === 1 && only.type === 'p') doc.execCommand('insertHTML', false, runsToHtml(only.runs));
	else doc.execCommand('insertHTML', false, blocksToHtml(blocks));
}
