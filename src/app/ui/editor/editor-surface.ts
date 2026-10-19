import { ChangeDetectionStrategy, Component, ElementRef, afterNextRender, computed, effect, inject, untracked, viewChild } from '@angular/core';
import { locateIssues } from '../../core/analysis/issues';
import type { Span } from '../../core/text/text';
import { DocumentStore } from '../../services/document.store';
import { AiClient } from '../../services/ai-client';
import { AnalysisService } from '../../services/analysis.service';
import { EditorService } from '../../services/editor.service';
import { ReadingCache } from '../../services/reading-cache';
import { SettingsStore } from '../../services/settings.store';

const MOD = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? 'Cmd' : 'Ctrl';

/**
 * The writing surface: the contenteditable manuscript, the thread in the margin and the
 * formatting bubble. Angular renders the frame; the manuscript itself belongs to the browser's
 * editing engine and `EditorService`.
 */
@Component({
	selector: 'tl-editor',
	changeDetection: ChangeDetectionStrategy.OnPush,
	templateUrl: './editor-surface.html',
	host: { class: 'surface', '(document:selectionchange)': 'onSelectionChange()' },
})
export class EditorSurface {
	readonly editor = inject(EditorService);
	private readonly analysis = inject(AnalysisService);
	private readonly cache = inject(ReadingCache);
	private readonly ai = inject(AiClient);
	readonly settings = inject(SettingsStore);
	private readonly docs = inject(DocumentStore);

	private readonly scroll = viewChild.required<ElementRef<HTMLElement>>('scroll');
	private readonly ed = viewChild.required<ElementRef<HTMLElement>>('ed');
	private readonly gutter = viewChild.required<ElementRef<HTMLElement>>('gutter');
	private selectionFrame = 0;
	private gutterFrame = 0;
	private window: [number, number] = [0, 0];

	readonly hint = `Write here, or open a .docx, .odt or .md file (${MOD}+O). Type # and a space for a heading.`;
	readonly bubble = computed(() => {
		const r = this.editor.selectionRect();
		if (!r) return null;
		const width = 300;
		const top = r.top - 44 < 52 ? r.bottom + 8 : r.top - 44;
		return { left: Math.max(8, Math.min(innerWidth - width - 8, r.left + r.width / 2 - width / 2)), top };
	});

	constructor() {
		afterNextRender(() => {
			this.editor.attach(this.ed().nativeElement, this.scroll().nativeElement);
			new ResizeObserver(() => this.drawGutterSoon()).observe(this.ed().nativeElement);
		});
		effect(() => {
			this.editor.structure();
			this.editor.position();
			this.cache.version();
			this.settings.editor();
			untracked(() => this.drawGutterSoon());
		});
		effect(() => {
			const running = new Set(this.ai.running().map(r => r.key));
			untracked(() => this.markRunning(running));
		});
		effect(() => this.paintHighlights());
	}

	onInput(e: Event): void { if (e instanceof InputEvent) this.editor.handleInput(e); }
	onPaste(e: ClipboardEvent): void { this.editor.handlePaste(e); }
	onPointerDown(): void { this.editor.lastPointer = Date.now(); }

	onClick(e: MouseEvent): void {
		const a = e.target instanceof Element ? e.target.closest('a') : null;
		if (a && (e.metaKey || e.ctrlKey)) { e.preventDefault(); window.open(a.href, '_blank', 'noopener'); }
	}

	onSelectionChange(): void {
		cancelAnimationFrame(this.selectionFrame);
		this.selectionFrame = requestAnimationFrame(() => this.editor.handleSelection());
	}

	onScroll(): void {
		const sc = this.scroll().nativeElement;
		const [lo, hi] = this.window;
		if (sc.scrollTop < lo + sc.clientHeight || sc.scrollTop + sc.clientHeight > hi - sc.clientHeight) this.drawGutterSoon();
		if (this.editor.selectionRect()) this.editor.handleSelection();
	}

	onGutterClick(e: MouseEvent): void {
		const bid = e.target instanceof HTMLElement ? e.target.dataset['bid'] : undefined;
		if (bid) this.editor.jumpTo(bid, { lens: true });
	}

	format(cmd: 'bold' | 'italic'): void { this.editor.format(cmd); }

	link(): void {
		const url = prompt('Link address (leave empty to remove the link)', this.editor.currentLink() ?? 'https://');
		if (url !== null) this.editor.setLink(url === 'https://' ? '' : url);
	}

	private drawGutterSoon(): void {
		cancelAnimationFrame(this.gutterFrame);
		this.gutterFrame = requestAnimationFrame(() => this.drawGutter());
	}

	/** Draws the thread for blocks near the viewport. Built with DOM calls; no HTML strings. */
	private drawGutter(): void {
		const g = this.gutter().nativeElement;
		if (!this.settings.editor().gutter) { g.replaceChildren(); return; }
		const sc = this.scroll().nativeElement;
		const lo = sc.scrollTop - sc.clientHeight * 1.5;
		const hi = sc.scrollTop + sc.clientHeight * 2.5;
		this.window = [lo, hi];
		const s = this.editor.structure();
		const cur = this.editor.position().section;
		const lineHeight = parseFloat(getComputedStyle(this.ed().nativeElement).lineHeight) || 30;
		const running = new Set(this.ai.running().map(r => r.key));
		const hidden = new Set([...this.docs.ignored(), ...this.editor.applied()]);
		const frag = document.createDocumentFragment();
		const el = (cls: string, top: number, height?: number): HTMLElement => {
			const e = document.createElement('span');
			e.className = cls;
			e.style.top = `${top}px`;
			if (height !== undefined) e.style.height = `${height}px`;
			frag.appendChild(e);
			return e;
		};
		for (const section of s.sections) {
			const isCur = section.index === cur;
			const fits = new Map((this.analysis.sectionReading(section)?.reading.paragraphs ?? []).map(p => [p.n, p]));
			if (section.head !== null) {
				const g0 = this.editor.geometry(s.blocks[section.head].bid);
				if (g0 && g0.top < hi && g0.top + g0.height > lo) el(`k head${isCur ? ' cur' : ''}`, g0.top + Math.round(g0.height / 2) - 4);
			}
			section.paras.forEach((bi, k) => {
				const b = s.blocks[bi];
				const geo = this.editor.geometry(b.bid);
				if (!geo) return;
				const nextIndex = section.paras[k + 1];
				const nextGeo = nextIndex === undefined ? null : this.editor.geometry(s.blocks[nextIndex].bid);
				const bottom = nextGeo ? nextGeo.top : geo.top + geo.height;
				if (bottom < lo || geo.top > hi) return;
				const fit = fits.get(b.n);
				const weak = !!fit?.bridge && fit.bridge <= 2 && b.n > 1;
				const off = !!fit?.fit && fit.fit <= 2;
				el(`seg${isCur ? ' cur' : ''}${weak ? ' weak' : ''}`, geo.top + 6, Math.max(0, bottom - geo.top));
				if (!b.paraKey) return;
				const para = this.analysis.paraReading(b);
				const y = geo.top + Math.round(lineHeight / 2) - 6;
				const state = !para ? '' : para.stale ? ' stale' : ' done';
				const knot = el(`k${state}${isCur ? ' cur' : ''}${off ? ' off' : ''}${running.has(b.paraKey) ? ' run' : ''}`, y);
				knot.dataset['bid'] = b.bid;
				knot.dataset['key'] = b.paraKey;
				const status = !para ? 'Not read by the model yet' : para.stale ? 'Edited since the last reading' : '';
				knot.title = [`¶ ${b.n}`, para?.reading.gist ?? '', status, off ? 'Strays from the section' : '', weak ? 'Weak link to the paragraph before' : '', 'Click to open in the lens'].filter(Boolean).join('. ');
				const n = para ? locateIssues(b.text, para.reading.issues, hidden).length : 0;
				if (n) {
					const c = el('n', y - 1);
					c.textContent = String(n);
					c.dataset['bid'] = b.bid;
					c.title = `${n} suggested edit${n === 1 ? '' : 's'} in ¶ ${b.n}. Click to open in the lens.`;
				}
			});
		}
		g.replaceChildren(frag);
	}

	private markRunning(running: ReadonlySet<string>): void {
		for (const k of Array.from(this.gutter().nativeElement.querySelectorAll<HTMLElement>('.k[data-key]'))) k.classList.toggle('run', running.has(k.dataset['key'] ?? ''));
	}

	private paintHighlights(): void {
		const ins = this.analysis.inspection();
		const layer = this.editor.layer();
		const sentence = this.editor.sentence();
		const lens = this.editor.lensOpen();
		const filters = this.editor.filters();
		const hover = this.editor.hoverIssue();
		const groups: Partial<Record<'tl-dim' | 'tl-cut' | 'tl-change' | 'tl-ambiguous' | 'tl-repetition' | 'tl-style' | 'tl-local' | 'tl-focus', Span[]>> = {};
		const add = (name: keyof typeof groups, span: Span): void => { (groups[name] ??= []).push(span); };
		if (ins) {
			if (layer === 'sentence') untracked(() => this.editor.sentences(ins.block.bid)).forEach((s, i) => { if (i !== sentence.index) add('tl-dim', s); });
			if (lens) {
				for (const issue of ins.issues) {
					if (!filters[issue.type]) continue;
					add(`tl-${issue.type}`, issue);
					if (hover === issue.id) add('tl-focus', issue);
				}
				if (filters.local) for (const r of ins.checks.repeats) for (const sp of r.spans) add('tl-local', sp);
			}
		}
		untracked(() => this.editor.paint(groups, ins?.block.bid ?? null));
	}
}
