import { Injectable, computed, inject, signal } from '@angular/core';
import type { LocatedIssue } from '../core/analysis/issues';
import type { IssueType } from '../core/analysis/readings';
import { EMPTY_STRUCTURE, buildStructure, type StructBlock, type Section, type Structure } from '../core/analysis/structure';
import {
	applyShortcut, blockElements, blockOf, blockText, caretOffset, domRuns, normalizeEditor, paste, rangeFor,
	renderBlocks, selectRange, setBlockType, signature, typeOf,
} from '../core/editor/dom';
import { splitParagraphs } from '../core/formats/plain-text';
import type { Block, BlockMeta, SaveBlock, TextBlockType } from '../core/model';
import { detectLanguage } from '../core/text/lang';
import { sentencesOf, type Sentence, type Span } from '../core/text/text';
import { newId } from '../core/util/strings';
import { DocumentStore } from './document.store';
import { SettingsStore } from './settings.store';

/** What the author is working on. Each layer dims everything outside it. */
export type Layer = 'document' | 'section' | 'paragraph' | 'sentence';
export const LAYERS: readonly Layer[] = ['document', 'section', 'paragraph', 'sentence'];
export type FilterKey = IssueType | 'local';
export interface Position { readonly bid: string | null; readonly index: number; readonly section: number }
/** Saved editor state for crash recovery. */
export interface EditorSnapshot { readonly html: string; readonly meta: [string, BlockMeta][]; readonly signatures: [string, string][] }

const HIGHLIGHTS = ['tl-dim', 'tl-cut', 'tl-change', 'tl-ambiguous', 'tl-repetition', 'tl-style', 'tl-local', 'tl-focus'] as const;
type HighlightName = (typeof HIGHLIGHTS)[number];

/**
 * Owns the contenteditable element. Angular never renders inside it: the browser's editing
 * engine does, and this service reads the result back into a `Structure` signal.
 */
@Injectable({ providedIn: 'root' })
export class EditorService {
	private readonly docs = inject(DocumentStore);
	private readonly settings = inject(SettingsStore);

	private root: HTMLElement | null = null;
	private scroller: HTMLElement | null = null;
	private meta = new Map<string, BlockMeta>();
	private signatures = new Map<string, string>();
	private elements = new Map<string, HTMLElement>();
	private currentEl: HTMLElement | null = null;
	private sectionEls: HTMLElement[] = [];
	private reindexTimer: ReturnType<typeof setTimeout> | undefined;
	private lastRange: Range | null = null;
	private sentenceCache: { text: string; sentences: Sentence[] } | null = null;
	private readonly typedListeners = new Set<() => void>();

	lastInput = 0;
	lastPointer = 0;

	readonly structure = signal<Structure>(EMPTY_STRUCTURE);
	readonly position = signal<Position>({ bid: null, index: -1, section: -1 });
	readonly sentence = signal({ index: 0, count: 0 });
	readonly layer = signal<Layer>('paragraph');
	readonly lensOpen = signal(false);
	readonly hoverIssue = signal<string | null>(null);
	readonly filters = signal<Record<FilterKey, boolean>>({ cut: true, change: true, ambiguous: true, repetition: true, style: true, local: true });
	/** Issues applied in this session; hidden until the paragraph is read again. */
	readonly applied = signal<ReadonlySet<string>>(new Set());
	/** Screen rectangle of a non-empty selection, for the formatting bubble. */
	readonly selectionRect = signal<DOMRect | null>(null);
	readonly blockType = signal<TextBlockType>('p');

	readonly currentBlock = computed((): StructBlock | null => this.structure().blocks[this.position().index] ?? null);
	readonly currentSection = computed((): Section | null => this.structure().sections[this.position().section] ?? null);
	/** The language guessed from the text, or null. Looks at the start of the document only. */
	readonly detectedLang = computed(() => {
		let text = '';
		for (const b of this.structure().blocks) { if (text.length > 4000) break; if (b.text) text += `${b.text}\n`; }
		return detectLanguage(text);
	});
	/** Language of the text: the author's choice, else the guess. Empty when unknown. */
	readonly textLang = computed(() => this.docs.settings().textLang || this.detectedLang() || '');
	readonly title = computed(() => {
		const own = this.docs.settings().title;
		if (own) return own;
		const h = this.structure().blocks.find(b => b.type === 'h1' && b.text.trim());
		if (h) return h.text.trim();
		const name = this.docs.file().name;
		return name ? name.replace(/\.[^.]+$/, '') : 'Untitled';
	});

	attach(root: HTMLElement, scroller: HTMLElement): void {
		this.root = root;
		this.scroller = scroller;
		try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch { /* older browsers */ }
		if (!root.firstChild) this.load([]);
	}

	onTyped(listener: () => void): void { this.typedListeners.add(listener); }

	element(bid: string): HTMLElement | null { return this.elements.get(bid) ?? null; }

	/** Replaces the document with `blocks`. */
	load(blocks: readonly Block[]): void {
		const root = this.root;
		if (!root) return;
		const ids = blocks.map(() => newId());
		renderBlocks(root, blocks.length ? blocks : [{ type: 'p', runs: [], meta: null }], ids.length ? ids : [newId()]);
		this.meta = new Map();
		blocks.forEach((b, k) => { if (b.meta) this.meta.set(ids[k], b.meta); });
		this.signatures = new Map();
		for (const el of blockElements(root)) {
			const bid = el.dataset['bid'];
			if (bid && this.meta.has(bid)) this.signatures.set(bid, signature(typeOf(el), domRuns(el)));
		}
		this.currentEl = null;
		this.applied.set(new Set());
		this.reindex();
	}

	snapshot(): EditorSnapshot | null {
		if (!this.root) return null;
		return { html: this.root.innerHTML, meta: [...this.meta], signatures: [...this.signatures] };
	}

	restore(s: EditorSnapshot): void {
		if (!this.root) return;
		this.root.innerHTML = s.html;
		for (const el of Array.from(this.root.querySelectorAll('.cur, .insec'))) el.classList.remove('cur', 'insec');
		this.meta = new Map(s.meta);
		this.signatures = new Map(s.signatures);
		this.currentEl = null;
		this.reindex();
	}

	/** Blocks for a writer. Unchanged blocks are marked so their original XML is reused. */
	blocksForSave(): SaveBlock[] {
		const root = this.root;
		if (!root) return [];
		this.reindex();
		const out: SaveBlock[] = [];
		for (const el of blockElements(root)) {
			const bid = el.dataset['bid'] ?? '';
			const m = this.meta.get(bid) ?? null;
			const type = typeOf(el);
			if (type === 'opaque') { if (m) out.push({ type, label: '', meta: m, unchanged: true }); continue; }
			const runs = domRuns(el);
			out.push({ type, runs, meta: m, unchanged: !!m && this.signatures.get(bid) === signature(type, runs) });
		}
		return out;
	}

	reindexSoon(): void {
		clearTimeout(this.reindexTimer);
		this.reindexTimer = setTimeout(() => this.reindex(), 450);
	}

	/** Repairs the DOM, gives every block a unique id and rebuilds the structure. */
	reindex(): void {
		clearTimeout(this.reindexTimer);
		const root = this.root;
		if (!root) return;
		normalizeEditor(root);
		const seen = new Set<string>();
		const elements = new Map<string, HTMLElement>();
		const inputs = blockElements(root).map(el => {
			let bid = el.dataset['bid'];
			if (!bid || seen.has(bid)) { bid = newId(); el.dataset['bid'] = bid; }
			seen.add(bid);
			elements.set(bid, el);
			const type = typeOf(el);
			return { bid, type, text: type === 'opaque' ? '' : blockText(el) };
		});
		this.elements = elements;
		const s = buildStructure(inputs, this.docs.settings());
		this.structure.set(s);
		root.classList.toggle('empty', s.blocks.length === 1 && !s.blocks[0].text && s.blocks[0].type === 'p');
		if (this.currentEl && !this.currentEl.isConnected) this.currentEl = null;
		this.updatePosition();
	}

	private updatePosition(): void {
		const s = this.structure();
		const bid = this.currentEl?.dataset['bid'] ?? null;
		const index = bid ? s.indexOf.get(bid) ?? -1 : -1;
		const section = index >= 0 ? s.blocks[index].section : s.sections.length ? 0 : -1;
		const prev = this.position();
		if (prev.bid !== bid || prev.index !== index || prev.section !== section) this.position.set({ bid, index, section });
		this.markSection(section);
	}

	private markSection(section: number): void {
		for (const el of this.sectionEls) el.classList.remove('insec');
		this.sectionEls = [];
		for (const b of this.structure().blocks) {
			if (b.section !== section) continue;
			const el = this.elements.get(b.bid);
			if (el) { el.classList.add('insec'); this.sectionEls.push(el); }
		}
	}

	/** Call from the editor's `input` event. */
	handleInput(e: InputEvent): void {
		this.lastInput = Date.now();
		const focus = document.getSelection()?.focusNode;
		const block = this.root && focus ? blockOf(this.root, focus) : null;
		this.docs.touch(block?.dataset['bid'] ?? 'text');
		if (e.inputType === 'insertText' && e.data === ' ' && this.root) { const root = this.root; queueMicrotask(() => applyShortcut(root)); }
		for (const l of this.typedListeners) l();
		this.reindexSoon();
	}

	handlePaste(e: ClipboardEvent): void {
		if (!this.root || !e.clipboardData) return;
		e.preventDefault();
		paste(this.root, e.clipboardData, splitParagraphs);
	}

	/** Call on `selectionchange`, at most once per frame. */
	handleSelection(): void {
		const root = this.root;
		const s = document.getSelection();
		if (!root || !s || !s.rangeCount || !s.focusNode || !root.contains(s.focusNode)) { this.selectionRect.set(null); return; }
		this.lastRange = s.getRangeAt(0).cloneRange();
		const b = blockOf(root, s.focusNode);
		if (b && b !== this.currentEl) this.setCurrent(b);
		this.updateSentence();
		const rect = s.isCollapsed ? null : s.getRangeAt(0).getBoundingClientRect();
		this.selectionRect.set(rect && (rect.width || rect.height) ? rect : null);
		if (this.settings.editor().typewriter && s.isCollapsed && Date.now() - this.lastPointer > 500) this.typewriter();
	}

	private setCurrent(el: HTMLElement): void {
		const root = this.root;
		if (!root) return;
		for (const x of Array.from(root.querySelectorAll('.cur'))) if (x !== el) x.classList.remove('cur');
		const bid = el.dataset['bid'];
		const same = bid ? root.querySelectorAll(`[data-bid="${CSS.escape(bid)}"]`) : null;
		if (!bid || (same && same.length > 1 && same[0] !== el)) { el.dataset['bid'] = newId(); this.reindexSoon(); }
		el.classList.add('cur');
		this.currentEl = el;
		const t = typeOf(el);
		if (t !== 'opaque') this.blockType.set(t);
		const known = this.structure().indexOf.get(el.dataset['bid'] ?? '');
		if (known === undefined) this.reindexSoon(); else this.updatePosition();
	}

	sentences(bid: string): Sentence[] {
		const el = this.elements.get(bid);
		if (!el) return [];
		const text = blockText(el);
		if (this.sentenceCache?.text !== text) this.sentenceCache = { text, sentences: sentencesOf(text, this.textLang()) };
		return this.sentenceCache.sentences;
	}

	private updateSentence(): void {
		const el = this.currentEl;
		let index = 0;
		let count = 0;
		if (el && (el.tagName === 'P' || el.tagName === 'LI')) {
			const sents = this.sentences(el.dataset['bid'] ?? '');
			const off = caretOffset(el);
			count = sents.length;
			index = Math.max(0, sents.findIndex((s, i) => off >= s.start && (off < s.end || i === sents.length - 1)));
		}
		const prev = this.sentence();
		if (prev.index !== index || prev.count !== count) this.sentence.set({ index, count });
	}

	private typewriter(): void {
		const s = document.getSelection();
		const sc = this.scroller;
		if (!s || !s.rangeCount || !sc) return;
		const r = s.getRangeAt(0).cloneRange();
		r.collapse(false);
		let rect: DOMRect | undefined = r.getClientRects()[0];
		if (!rect || !rect.height) rect = this.currentEl?.getBoundingClientRect();
		if (!rect) return;
		const box = sc.getBoundingClientRect();
		const y = rect.top - box.top;
		const target = box.height * 0.42;
		if (Math.abs(y - target) > box.height * 0.1) sc.scrollTo({ top: sc.scrollTop + y - target, behavior: 'smooth' });
	}

	setLayer(layer: Layer): void { this.layer.set(layer); }

	/** Moves the cursor to the start of a block and scrolls it to the middle. */
	jumpTo(bid: string, opts: { lens?: boolean } = {}): void {
		const el = this.elements.get(bid);
		if (!el) return;
		el.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
		if (!el.classList.contains('opaque')) {
			this.root?.focus({ preventScroll: true });
			selectRange(rangeFor(el, 0, 0));
			this.lastPointer = Date.now();
		}
		this.setCurrent(el);
		if (opts.lens) this.lensOpen.set(true);
	}

	/** Puts the cursor back into the editor, where it last was. */
	refocus(): void {
		const root = this.root;
		if (!root) return;
		const s = document.getSelection();
		if (document.activeElement !== root) root.focus({ preventScroll: true });
		if ((!s || !s.rangeCount || !root.contains(s.anchorNode)) && this.lastRange) selectRange(this.lastRange);
	}

	changeBlockType(type: TextBlockType): void {
		if (!this.root) return;
		this.refocus();
		setBlockType(this.root, type);
		this.reindexSoon();
	}

	format(command: 'bold' | 'italic'): void { this.refocus(); document.execCommand(command); }

	/** The link under the cursor, if any. */
	currentLink(): string | null {
		const n = document.getSelection()?.anchorNode;
		const el = n instanceof Element ? n : n?.parentElement;
		return el?.closest('a')?.getAttribute('href') ?? null;
	}

	/** Sets, changes or (with an empty url) removes the link at the selection. */
	setLink(url: string): void {
		this.refocus();
		const s = document.getSelection();
		if (!s || !s.rangeCount) return;
		const n = s.anchorNode;
		const a = (n instanceof Element ? n : n?.parentElement)?.closest('a') ?? null;
		const clean = url.trim();
		if (!clean) {
			if (a) { const r = document.createRange(); r.selectNodeContents(a); selectRange(r); }
			document.execCommand('unlink');
		} else if (s.isCollapsed && a) {
			a.setAttribute('href', clean);
			const block = this.root ? blockOf(this.root, a) : null;
			this.docs.touch(block?.dataset['bid'] ?? 'text');
		} else if (s.isCollapsed) {
			document.execCommand('insertText', false, clean);
			const r = document.createRange();
			const node = s.anchorNode;
			if (node) { r.setStart(node, Math.max(0, s.anchorOffset - clean.length)); r.setEnd(node, s.anchorOffset); selectRange(r); document.execCommand('createLink', false, clean); }
		} else document.execCommand('createLink', false, clean);
		this.reindexSoon();
	}

	/** Applies a suggestion through the browser's undoable editing commands. */
	applyIssue(bid: string, issue: LocatedIssue): void {
		const el = this.elements.get(bid);
		if (!el) return;
		const text = blockText(el);
		let { start, end } = issue;
		const replacement = issue.type === 'cut' ? '' : issue.suggestion;
		if (!replacement) {
			if (text[end] === ' ' && (start === 0 || text[start - 1] === ' ')) end++;
			else if (text[start - 1] === ' ' && /[\s.,;:!?)]/.test(text[end] ?? ' ')) start--;
		}
		this.root?.focus({ preventScroll: true });
		selectRange(rangeFor(el, start, end));
		if (replacement) document.execCommand('insertText', false, replacement);
		else document.execCommand('delete');
		this.applied.update(s => new Set(s).add(issue.id));
	}

	selectText(bid: string, span: Span): void {
		const el = this.elements.get(bid);
		if (!el) return;
		this.root?.focus({ preventScroll: true });
		selectRange(rangeFor(el, span.start, span.end));
	}

	/** Paints highlights with the CSS Custom Highlight API. No-op where the API is missing. */
	paint(groups: Partial<Record<HighlightName, readonly Span[]>>, bid: string | null): void {
		if (typeof CSS === 'undefined' || !('highlights' in CSS) || typeof Highlight === 'undefined') return;
		const el = bid ? this.elements.get(bid) : null;
		for (const name of HIGHLIGHTS) {
			const spans = groups[name] ?? [];
			if (el && spans.length) CSS.highlights.set(name, new Highlight(...spans.map(s => rangeFor(el, s.start, s.end))));
			else CSS.highlights.delete(name);
		}
	}

	/** Pixel geometry of blocks for the margin thread, relative to `page`. */
	geometry(bid: string): { top: number; height: number } | null {
		const el = this.elements.get(bid);
		const root = this.root;
		if (!el || !root) return null;
		return { top: root.offsetTop + el.offsetTop, height: el.offsetHeight };
	}
}
