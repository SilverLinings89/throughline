import { Injectable, computed, effect, inject, untracked } from '@angular/core';
import { URGENT, type Job, type JobKind } from '../core/ai/protocol';
import { locateIssues, type LocatedIssue } from '../core/analysis/issues';
import { SCHEMAS, chatPrompt, documentPrompt, paragraphPrompt, sectionPrompt, type ChatTurn, type OutlineLine } from '../core/analysis/prompts';
import type { DocReading, EmbeddedData, ParaReading, ParagraphFit, Reading, SectionReading } from '../core/analysis/readings';
import { docChanged, sectionBasis, sectionChanged, type DocBasis, type SectionBasis } from '../core/analysis/refresh';
import type { Section, StructBlock } from '../core/analysis/structure';
import { localChecks, type LocalChecks } from '../core/text/text';
import { newId } from '../core/util/strings';
import { AiClient } from './ai-client';
import { DocumentStore } from './document.store';
import { EditorService } from './editor.service';
import { ReadingCache } from './reading-cache';
import { SettingsStore } from './settings.store';
import { UiState, type ChatEntry } from './ui-state';

/** A reading and whether it belongs to an earlier version of the text. */
export interface Found<T> { readonly reading: T; readonly stale: boolean }

/** Everything the lens and the highlights need about the paragraph under the cursor. */
export interface Inspection {
	readonly block: StructBlock;
	readonly section: Section | null;
	readonly para: Found<ParaReading> | null;
	readonly fit: ParagraphFit | null;
	readonly issues: readonly LocatedIssue[];
	readonly checks: LocalChecks;
	readonly running: boolean;
}

type ReadKind = Exclude<JobKind, 'chat'>;
interface Candidate { readonly key: string; readonly kind: ReadKind; readonly priority: number; readonly origin: Origin; readonly build: () => Job }
/** Where a job's text came from, so its answer still lands there after the text was edited. */
interface Origin { readonly bid?: string; readonly titleKey?: string; readonly basis?: SectionBasis; readonly doc?: DocBasis }

/** Background jobs waiting or running at any time. Keeps the queue short and the machine usable. */
const MAX_IN_FLIGHT = 3;
/** Answer length limits when the setting is 0: enough for a full reading, short of a runaway answer. */
const MAX_TOKENS: Record<ReadKind, number> = { para: 1500, section: 2500, doc: 2500 };
/** How long the cursor rests in a paragraph before it is read, so moving through the text sends nothing. */
const DWELL_MS = 2000;
const DWELL_LENS_MS = 1200;
/** Quiet time before the section you are writing in is read again. */
const SECTION_IDLE_MS = 20e3;

/**
 * Decides what the model reads next and turns readings into view data.
 *
 * - Paragraphs: only the one the cursor rests in, after you pause typing. One reading per paragraph at a time.
 * - Sections: when a section has no reading yet (for example after opening a file), when the main line,
 *   style or language changed, or when a quarter of its text changed. The section you write in waits until
 *   you pause for a while.
 * - The whole text: after all sections are read, when it was never read, the settings or headings changed,
 *   or a third of the sections got new readings (at most every ten minutes).
 *
 * At most `MAX_IN_FLIGHT` jobs wait or run. A running job is never cancelled: its answer is kept as the
 * reading of the earlier version. Queued jobs that are no longer wanted are dropped.
 */
@Injectable({ providedIn: 'root' })
export class AnalysisService {
	private readonly ai = inject(AiClient);
	private readonly cache = inject(ReadingCache);
	private readonly editor = inject(EditorService);
	private readonly docs = inject(DocumentStore);
	private readonly settings = inject(SettingsStore);
	private readonly ui = inject(UiState);
	private lastDocRun = 0;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private dwellTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly origins = new Map<string, Origin>();
	/** What each section (by title) looked like when its current reading was made. */
	private readonly sectionBases = new Map<string, SectionBasis>();
	private docBasis: DocBasis | undefined;
	/** The paragraph the cursor is in and since when. */
	private arrived: { bid: string | null; at: number } = { bid: null, at: 0 };

	readonly inspection = computed((): Inspection | null => {
		const block = this.editor.currentBlock();
		if (!block || !(block.type === 'p' || block.type === 'ul' || block.type === 'ol') || !block.text.trim()) return null;
		const section = this.editor.structure().sections[block.section] ?? null;
		const para = this.paraReading(block);
		const sec = section ? this.sectionReading(section) : null;
		const hidden = new Set([...this.docs.ignored(), ...this.editor.applied()]);
		return {
			block, section, para,
			fit: sec?.reading.paragraphs.find(p => p.n === block.n) ?? null,
			issues: para ? locateIssues(block.text, para.reading.issues, hidden) : [],
			checks: localChecks(block.text, sec?.reading.keywords ?? [], this.editor.textLang()),
			running: this.ai.running().some(r => r.key === block.paraKey),
		};
	});

	constructor() {
		this.ai.onResult((key, reading) => this.onResult(key, reading));
		this.ai.onFailure(key => { this.origins.delete(key); this.scheduleSoon(); });
		this.editor.onTyped(() => this.ai.hold());
		effect(() => {
			this.editor.structure();
			this.editor.position();
			this.editor.lensOpen();
			this.ai.ready();
			untracked(() => this.scheduleSoon());
		});
		setInterval(() => { if (!document.hidden) this.schedule(); }, 4000);
	}

	paraReading(b: StructBlock): Found<ParaReading> | null {
		if (!b.paraKey) return null;
		const fresh = this.cache.para(b.paraKey);
		if (fresh) return { reading: fresh, stale: false };
		const old = this.cache.para(this.cache.byBlock.get(b.bid) ?? null);
		return old ? { reading: old, stale: true } : null;
	}

	sectionReading(s: Section): Found<SectionReading> | null {
		const fresh = this.cache.section(s.key);
		if (fresh) return { reading: fresh, stale: false };
		const old = this.cache.section(this.cache.bySectionTitle.get(s.titleKey) ?? null);
		return old ? { reading: old, stale: true } : null;
	}

	docReading(): Found<DocReading> | null {
		const fresh = this.cache.doc(this.editor.structure().docKey);
		if (fresh) return { reading: fresh, stale: false };
		const old = this.cache.doc(this.cache.lastDocKey);
		return old ? { reading: old, stale: true } : null;
	}

	/** Sections that appear in the outline, in order. Feedback refers to them by 1-based position. */
	listedSections(): Section[] {
		const s = this.editor.structure();
		return s.sections.filter(x => x.head !== null || x.paras.length);
	}

	private outline(): OutlineLine[] {
		return this.listedSections().map(x => {
			const r = this.sectionReading(x)?.reading;
			return { level: x.level, title: x.title, summary: r?.summary ?? null, keywords: r?.keywords ?? [] };
		});
	}

	scheduleSoon(): void {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => this.schedule(), 250);
	}

	schedule(): void {
		clearTimeout(this.timer);
		if (!this.ai.ready()) return;
		const s = this.editor.structure();
		const pos = this.editor.position();
		const a = this.settings.ai();
		const settings = this.docs.settings();
		for (const b of s.blocks) if (b.paraKey && this.cache.has(b.paraKey)) this.cache.byBlock.set(b.bid, b.paraKey);
		for (const x of s.sections) if (x.key && this.cache.has(x.key)) this.cache.bySectionTitle.set(x.titleKey, x.key);
		const now = Date.now();
		const idle = now - this.editor.lastInput;
		const lens = this.editor.lensOpen();
		const running = new Set(this.ai.running().map(r => r.key));
		const busy = [...running, ...this.ai.pending.keys()].map(k => this.origins.get(k));
		const busyBids = new Set(busy.map(o => o?.bid));
		const busyTitles = new Set(busy.map(o => o?.titleKey));
		const sig = `${settings.thread}|${settings.style}|${settings.language}`;
		const cand: Candidate[] = [];

		// The paragraph the cursor rests in, once you pause. Nothing else is read paragraph by paragraph.
		if (pos.bid !== this.arrived.bid) this.arrived = { bid: pos.bid, at: now };
		const b = s.blocks[pos.index];
		if (b?.paraKey && !this.cache.has(b.paraKey) && !this.ai.blocked(b.paraKey) && !busyBids.has(b.bid)) {
			const wait = Math.max((lens ? 1500 : a.paraDelaySec * 1000) - idle, (lens ? DWELL_LENS_MS : DWELL_MS) - (now - this.arrived.at));
			if (wait > 0) { clearTimeout(this.dwellTimer); this.dwellTimer = setTimeout(() => this.schedule(), wait + 50); }
			else {
				const key = b.paraKey;
				const text = b.text;
				cand.push({ key, kind: 'para', priority: 90, origin: { bid: b.bid }, build: () => this.job(key, 'para', 90, `¶ ${b.n}`, paragraphPrompt(text, settings), SCHEMAS.para) });
			}
		}

		// Sections without a reading, or changed substantially since their reading.
		let sectionsDue = 0;
		for (const x of s.sections) {
			const key = x.key;
			if (!key) continue;
			const basis = sectionBasis(x.paras.map(i => s.blocks[i]), sig);
			if (this.cache.has(key)) { this.sectionBases.set(x.titleKey, basis); continue; }
			if (this.ai.blocked(key)) continue;
			if (this.sectionReading(x) && !sectionChanged(this.sectionBases.get(x.titleKey), basis)) continue;
			sectionsDue++;
			if (busyTitles.has(x.titleKey) && !this.ai.pending.has(key)) continue;
			const isCur = x.index === pos.section;
			if (isCur && idle < SECTION_IDLE_MS) continue;
			const priority = isCur ? 70 : 35 - Math.min(10, Math.abs(x.index - pos.section) / 5);
			const label = x.title.length > 26 ? `${x.title.slice(0, 25)}…` : x.title;
			const paragraphs = x.paras.map(i => s.blocks[i].text);
			cand.push({ key, kind: 'section', priority, origin: { titleKey: x.titleKey, basis }, build: () => this.job(key, 'section', priority, label, sectionPrompt({ pathText: x.pathText, paragraphs, settings, budget: a.budget }), SCHEMAS.section) });
		}

		// The whole text, once the sections are done.
		const dk = s.docKey;
		const keyed = s.sections.filter(x => x.key);
		if (dk && keyed.length >= 2 && !sectionsDue) {
			const docSig = `${sig}|${settings.title}`;
			const titles = keyed.map(x => x.title).join('\n');
			const docBusy = busy.some(o => o?.doc);
			if (this.cache.has(dk)) this.docBasis = { sig: docSig, titles, freshSections: 0 };
			else if (!docBusy && !this.ai.blocked(dk) && docChanged(this.docBasis, docSig, titles, keyed.length, now - this.lastDocRun)) {
				cand.push({ key: dk, kind: 'doc', priority: 40, origin: { doc: { sig: docSig, titles, freshSections: 0 } }, build: () => this.job(dk, 'doc', 40, 'the whole text', documentPrompt({ outline: this.outline(), settings }), SCHEMAS.doc) });
			}
		}

		const unchecked = cand.map(c => c.key).filter(k => !this.cache.isChecked(k));
		if (unchecked.length) { void this.cache.lookup(unchecked).then(() => this.schedule()); return; }
		// Drop queued work that is no longer wanted. Running work finishes.
		const wanted = new Set(cand.map(c => c.key));
		const drop = [...this.ai.pending.keys()].filter(k => !k.startsWith('chat:') && !wanted.has(k) && !running.has(k));
		for (const k of drop) this.origins.delete(k);
		this.ai.cancel(drop);
		cand.sort((x, y) => y.priority - x.priority);
		let inFlight = [...this.ai.pending.keys()].filter(k => !k.startsWith('chat:')).length;
		const jobs: Job[] = [];
		const changed: [string, number][] = [];
		for (const c of cand) {
			const known = this.ai.pending.get(c.key);
			if (known !== undefined) { if (known !== c.priority) changed.push([c.key, c.priority]); continue; }
			if (inFlight >= MAX_IN_FLIGHT) continue;
			inFlight++;
			this.origins.set(c.key, c.origin);
			jobs.push(c.build());
			if (c.kind === 'doc') this.lastDocRun = now;
		}
		this.ai.enqueue(jobs);
		this.ai.reprioritize(changed);
	}

	private job(key: string, kind: ReadKind, priority: number, label: string, messages: Job['messages'], schema: object): Job {
		return { key, kind, priority, label, messages, schema, json: true, maxTokens: MAX_TOKENS[kind] };
	}

	/** Reads the paragraph under the cursor now. `again` discards the stored reading first. */
	readCurrent(again: boolean): void {
		const b = this.editor.currentBlock();
		const key = b?.paraKey;
		if (!b || !key || !this.ai.ready()) return;
		if (!again && (this.cache.has(key) || this.ai.pending.has(key))) return;
		this.ai.forgive(key);
		if (again) this.cache.forget(key);
		this.origins.set(key, { bid: b.bid });
		this.ai.enqueue([this.job(key, 'para', again ? URGENT : 95, `¶ ${b.n}`, paragraphPrompt(b.text, this.docs.settings()), SCHEMAS.para)]);
	}

	private onResult(key: string, reading: Reading): void {
		this.cache.put(key, reading);
		const origin = this.origins.get(key);
		this.origins.delete(key);
		const s = this.editor.structure();
		if (reading.kind === 'para') {
			for (const b of s.blocks) if (b.paraKey === key) this.cache.byBlock.set(b.bid, key);
			// The paragraph was edited while it was read: keep the answer as its earlier reading.
			const b = origin?.bid ? s.blocks[s.indexOf.get(origin.bid) ?? -1] : undefined;
			if (b?.paraKey && b.paraKey !== key && !this.cache.has(b.paraKey)) this.cache.byBlock.set(b.bid, key);
		} else if (reading.kind === 'section') {
			for (const x of s.sections) if (x.key === key) this.cache.bySectionTitle.set(x.titleKey, key);
			if (origin?.titleKey) {
				const current = s.sections.find(x => x.titleKey === origin.titleKey);
				if (!current?.key || !this.cache.has(current.key)) this.cache.bySectionTitle.set(origin.titleKey, key);
				if (origin.basis) this.sectionBases.set(origin.titleKey, origin.basis);
			}
			if (this.docBasis) this.docBasis.freshSections++;
		} else {
			this.cache.lastDocKey = key;
			if (origin?.doc) this.docBasis = origin.doc;
		}
		this.scheduleSoon();
	}

	/** Asks a free-form question about the text. The answer streams into `UiState.chat`. */
	ask(question: string): boolean {
		const q = question.trim();
		if (!q || !this.ai.ready()) return false;
		const history: ChatTurn[] = this.ui.chat().filter(m => !m.pending && !m.failed).map(m => ({ role: m.role, text: m.text }));
		const s = this.editor.structure();
		const sec = this.editor.currentSection();
		const answer: ChatEntry = { role: 'assistant', text: '', pending: true, failed: false };
		this.ui.chat.update(c => [...c, { role: 'user', text: q, pending: false, failed: false }, answer]);
		const touch = (): void => this.ui.chat.update(c => [...c]);
		const key = `chat:${newId()}`;
		const messages = chatPrompt({
			settings: this.docs.settings(), outline: this.outline(), question: q, history, budget: this.settings.ai().budget,
			section: sec ? { pathText: sec.pathText, paragraphs: sec.paras.map(i => s.blocks[i].text) } : null,
			current: this.editor.currentBlock()?.text ?? '',
		});
		this.ai.chat(key, { key, kind: 'chat', priority: URGENT, label: 'your question', messages, json: false, stream: true, temperature: 0.4 }, {
			chunk: t => { answer.text = t; touch(); },
			done: t => { answer.text = t.trim() || 'The model returned an empty answer.'; answer.pending = false; touch(); },
			fail: e => { answer.text = e; answer.pending = false; answer.failed = true; touch(); },
		});
		return true;
	}

	/** Readings and settings to store in a saved file. */
	embedData(): EmbeddedData {
		const s = this.editor.structure();
		const keys = new Set<string>();
		for (const b of s.blocks) {
			if (b.paraKey) keys.add(b.paraKey);
			const last = this.cache.byBlock.get(b.bid);
			if (last) keys.add(last);
		}
		const secByTitle: Record<string, string> = {};
		for (const x of s.sections) {
			if (x.key) keys.add(x.key);
			const last = this.cache.bySectionTitle.get(x.titleKey);
			if (last) { keys.add(last); secByTitle[x.titleKey] = last; }
		}
		if (s.docKey) keys.add(s.docKey);
		if (this.cache.lastDocKey) keys.add(this.cache.lastDocKey);
		const cache: Record<string, Reading> = {};
		for (const k of keys) { const r = this.cache.get(k); if (r) cache[k] = r; }
		return {
			app: 'Throughline', v: 1, saved: new Date().toISOString(), settings: this.docs.settings(), cache, secByTitle,
			lastDoc: this.cache.lastDocKey, ignored: [...this.docs.ignored()], dismissed: [...this.docs.dismissed()],
		};
	}

	/** Takes over readings stored in an opened file. */
	loadEmbedded(data: EmbeddedData | null): void {
		this.ai.clear();
		this.cache.resetDocument();
		this.origins.clear();
		this.sectionBases.clear();
		this.docBasis = undefined;
		this.lastDocRun = 0;
		if (!data) return;
		const entries = Object.entries(data.cache);
		for (const [k, r] of entries) this.cache.put(k, r, false);
		void this.cache.db.putMany('cache', entries);
		for (const [t, k] of Object.entries(data.secByTitle)) this.cache.bySectionTitle.set(t, k);
		this.cache.lastDocKey = data.lastDoc;
	}
}
