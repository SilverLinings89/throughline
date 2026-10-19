import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { advice, groupBy, seconds, summarize, toCsv, type MetricSummary, type RequestMetric } from '../../core/ai/metrics';
import type { JobKind, StructuredMode } from '../../core/ai/protocol';
import type { DocSettings } from '../../core/model';
import { TEXT_LANGUAGES, languageName } from '../../core/text/lang';
import { AiClient } from '../../services/ai-client';
import { DocumentStore } from '../../services/document.store';
import { EditorService } from '../../services/editor.service';
import { Notifier } from '../../services/notifier';
import { ReadingCache } from '../../services/reading-cache';
import { SettingsStore, type AiSettings, type EditorSettings } from '../../services/settings.store';
import { UiState, type SettingsTab } from '../../services/ui-state';

export const STYLE_PRESETS: readonly { readonly name: string; readonly text: string }[] = [
	{ name: 'Academic', text: 'Precise academic prose for an educated reader. Define terms on first use and use them consistently. Prefer the active voice. One claim per sentence where possible. No rhetorical questions, no colloquialisms. Hedge only where the evidence requires it.' },
	{ name: 'Essay', text: 'Clear essayistic nonfiction with a personal but disciplined voice. Concrete examples before abstractions. Vary sentence length. Avoid jargon and filler words. Each paragraph makes one move in the argument.' },
	{ name: 'Journalistic', text: 'Plain, direct prose. Short sentences, strong verbs, concrete nouns. Lead with the point. Attribute claims. No adjectives that judge without evidence.' },
	{ name: 'Fiction', text: 'Literary fiction. Show through action and detail rather than explanation. Keep point of view consistent. Avoid clichés and dialogue tags other than "said" unless needed. Vary rhythm.' },
];
export const SERVER_PRESETS: readonly { readonly name: string; readonly url: string }[] = [
	{ name: 'Ollama', url: 'http://localhost:11434/v1' }, { name: 'LM Studio', url: 'http://localhost:1234/v1' },
	{ name: 'llama.cpp', url: 'http://localhost:8080/v1' }, { name: 'Jan', url: 'http://localhost:1337/v1' },
];
const KIND_LABEL: Record<JobKind, string> = { para: 'Paragraph readings', section: 'Section readings', doc: 'Whole-text readings', chat: 'Questions (Ask)' };
const OUTCOME_LABEL: Record<RequestMetric['outcome'], string> = { ok: 'ok', invalid: 'unusable answer', error: 'failed', timeout: 'timed out', cancelled: 'cancelled', preempted: 'interrupted' };
const MOD = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? 'Cmd' : 'Ctrl';

/** Settings in four tabs: this document, the model, its usage, and the editor. Changes apply as you type. */
@Component({
	selector: 'tl-settings',
	changeDetection: ChangeDetectionStrategy.OnPush,
	templateUrl: './settings-dialog.html',
})
export class SettingsDialog {
	readonly ui = inject(UiState);
	readonly settings = inject(SettingsStore);
	readonly docs = inject(DocumentStore);
	readonly editor = inject(EditorService);
	readonly ai = inject(AiClient);
	private readonly cache = inject(ReadingCache);
	private readonly notifier = inject(Notifier);
	private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
	private reindexTimer: ReturnType<typeof setTimeout> | undefined;

	readonly stylePresets = STYLE_PRESETS;
	readonly serverPresets = SERVER_PRESETS;
	readonly mod = MOD;
	readonly tabs: readonly { readonly id: SettingsTab; readonly label: string }[] = [{ id: 'doc', label: 'This document' }, { id: 'ai', label: 'Model' }, { id: 'usage', label: 'Usage' }, { id: 'editor', label: 'Editor' }];
	readonly modes: readonly { readonly id: StructuredMode; readonly label: string }[] = [{ id: 'auto', label: 'Find out automatically' }, { id: 'json_schema', label: 'JSON schema' }, { id: 'json_object', label: 'JSON mode' }, { id: 'none', label: 'Plain text' }];
	readonly models = signal<readonly string[]>([]);
	/** The listed languages, plus the document's own tag when it is not among them. */
	readonly textLanguages = computed(() => {
		const own = this.docs.settings().textLang;
		return own && !TEXT_LANGUAGES.some(l => l.code === own) ? [...TEXT_LANGUAGES, { code: own, name: languageName(own) }] : TEXT_LANGUAGES;
	});
	readonly detectedLabel = computed(() => {
		const d = this.editor.detectedLang();
		return d ? `Detect (now: ${languageName(d)})` : 'Detect (not sure yet)';
	});
	/** Usage tab: this session only, or everything recorded in this browser. */
	readonly usageScope = signal<'session' | 'all'>('session');
	readonly seconds = seconds;
	readonly usage = computed(() => {
		const all = this.ai.metrics();
		const list = this.usageScope() === 'session' ? all.filter(m => m.at >= this.ai.sessionStart) : all;
		const model = this.settings.ai().model;
		const forModel = list.filter(m => m.model === model);
		const row = (label: string, s: MetricSummary) => ({ label, s });
		return {
			total: list.length,
			since: all.length ? new Date(all[0].at).toLocaleDateString([], { dateStyle: 'medium' }) : '',
			model,
			models: [...groupBy(list, m => m.model || '(none)')].map(([k, v]) => row(k, summarize(v))),
			kinds: [...groupBy(forModel, m => m.kind)].map(([k, v]) => row(KIND_LABEL[k], summarize(v))),
			advice: advice(forModel, this.settings.ai().paraDelaySec),
			estimated: list.some(m => m.estimated),
			recent: list.slice(-25).reverse().map(m => ({
				time: new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
				kind: KIND_LABEL[m.kind].replace(/ readings?| \(Ask\)/, ''), model: m.model, ms: m.ms, wait: m.waitMs,
				tokens: `${m.promptTokens} → ${m.completionTokens}${m.estimated ? ' ≈' : ''}`, outcome: OUTCOME_LABEL[m.outcome], bad: m.outcome !== 'ok',
			})),
		};
	});
	/** Show a text field instead of the list of the server's models. */
	readonly manualModel = signal(false);
	/** The server's models, plus the configured one when the server does not list it. */
	readonly modelOptions = computed(() => {
		const current = this.settings.ai().model;
		const list = this.models().map(id => ({ id, label: id }));
		return current && !this.models().includes(current) ? [{ id: current, label: `${current} (not on this server)` }, ...list] : list;
	});
	readonly testResult = signal<{ readonly ok: boolean; readonly text: string } | null>(null);

	constructor() {
		effect(() => {
			const open = this.ui.settingsTab() !== null;
			const d = this.dialog().nativeElement;
			if (open && !d.open) d.showModal();
			if (!open && d.open) d.close();
		});
		// Fetch the model list once when the Model tab opens, so it can be picked from.
		effect(() => {
			if (this.ui.settingsTab() !== 'ai') return;
			untracked(() => { if (!this.models().length && !this.testResult() && this.settings.ai().baseUrl) void this.test(); });
		});
	}

	/** A new address or key may mean other models: forget the list and ask the server again. */
	setServer(patch: Partial<AiSettings>): void {
		this.setAi(patch);
		this.models.set([]);
		this.testResult.set(null);
		void this.test();
	}

	onClose(): void { this.ui.settingsTab.set(null); this.editor.refocus(); }
	onBackdrop(e: MouseEvent): void { if (e.target === this.dialog().nativeElement) this.ui.settingsTab.set(null); }

	setDoc(patch: Partial<DocSettings>): void {
		this.docs.updateSettings(patch);
		clearTimeout(this.reindexTimer);
		this.reindexTimer = setTimeout(() => this.editor.reindex(), 700);
	}
	setAi(patch: Partial<AiSettings>): void { this.settings.updateAi(patch); }
	setEditor(patch: Partial<EditorSettings>): void { this.settings.updateEditor(patch); }
	num(v: string): number { return Number(v); }
	mode(v: string): StructuredMode { return this.modes.find(m => m.id === v)?.id ?? 'auto'; }
	focusMode(v: string): EditorSettings['focus'] { return v === 'strong' ? 'strong' : 'soft'; }
	theme(v: string): EditorSettings['theme'] { return v === 'light' || v === 'dark' ? v : 'auto'; }

	async test(): Promise<void> {
		this.testResult.set({ ok: true, text: 'Checking…' });
		const a = this.settings.ai();
		const r = await this.ai.test(a.baseUrl, a.apiKey);
		if (this.settings.ai().baseUrl !== a.baseUrl || this.settings.ai().apiKey !== a.apiKey) return; // the server changed meanwhile
		if (!r.ok) { this.models.set([]); this.testResult.set({ ok: false, text: r.error }); return; }
		this.models.set([...r.models].sort((x, y) => x.localeCompare(y)));
		this.manualModel.set(false);
		this.testResult.set({ ok: true, text: r.models.length ? `Connected. ${r.models.length} model${r.models.length === 1 ? '' : 's'} available.` : 'Connected, but the server lists no models. Type the name by hand.' });
		if (!a.model && r.models.length === 1) this.setAi({ model: r.models[0] });
	}

	setScope(v: string): void { this.usageScope.set(v === 'all' ? 'all' : 'session'); }
	tokens(n: number | null): string { return n === null ? '–' : n >= 10000 ? `${Math.round(n / 1000)}k` : String(n); }
	percent(part: number, whole: number): string { return whole ? `${Math.round((100 * part) / whole)} %` : '–'; }

	async copyCsv(): Promise<void> {
		try { await navigator.clipboard.writeText(toCsv(this.ai.metrics())); this.notifier.say('Measurements copied as CSV.'); }
		catch { this.notifier.say('The browser did not allow copying.'); }
	}
	clearUsage(): void {
		if (!confirm('Delete all recorded measurements?')) return;
		this.ai.clearMetrics();
	}

	async forget(): Promise<void> {
		if (!confirm('Forget every stored reading? Open documents are read again from scratch.')) return;
		this.ai.clear();
		await this.cache.clearAll();
		this.editor.reindex();
		this.notifier.say('Stored readings forgotten.');
	}
}
