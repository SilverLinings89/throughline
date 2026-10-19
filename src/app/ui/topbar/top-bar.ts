import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import type { TextBlockType } from '../../core/model';
import { AiClient } from '../../services/ai-client';
import { DocumentStore } from '../../services/document.store';
import { EditorService, type Layer } from '../../services/editor.service';
import { FilesService } from '../../services/files.service';
import { SettingsStore } from '../../services/settings.store';
import { UiState } from '../../services/ui-state';

interface Crumb { readonly layer: Layer; readonly label: string }
const LAYER_TITLE: Record<Layer, string> = {
	document: 'Work on the whole document (Ctrl+Shift+1)',
	section: 'Focus on this section (Ctrl+Shift+2)',
	paragraph: 'Focus on this paragraph (Ctrl+Shift+3)',
	sentence: 'Focus on this sentence (Ctrl+Shift+4)',
};
const MOD = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? 'Cmd' : 'Ctrl';
/** Unsaved work older than this, or touching this many paragraphs, gets a stronger reminder. */
const WARN_AFTER_MIN = 15;
const WARN_AFTER_CHANGES = 10;

function ago(ms: number): string {
	const min = Math.floor(ms / 60e3);
	if (min < 1) return 'just now';
	if (min < 60) return `${min} min`;
	const h = Math.floor(min / 60);
	return `${h} h${min % 60 ? ` ${min % 60} min` : ''}`;
}
const clock = (t: number): string => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** Location and layer switch, paragraph type, lens toggle, save reminder, focus mode and model status. */
@Component({
	selector: 'tl-top-bar',
	changeDetection: ChangeDetectionStrategy.OnPush,
	templateUrl: './top-bar.html',
	host: { class: 'top' },
})
export class TopBar {
	readonly editor = inject(EditorService);
	readonly ui = inject(UiState);
	readonly files = inject(FilesService);
	readonly settings = inject(SettingsStore);
	private readonly ai = inject(AiClient);
	private readonly docs = inject(DocumentStore);
	readonly layerTitle = LAYER_TITLE;
	readonly mod = MOD;
	/** Ticks every 20 seconds so "unsaved for …" stays current. */
	private readonly now = signal(Date.now());

	constructor() {
		const timer = setInterval(() => this.now.set(Date.now()), 20e3);
		inject(DestroyRef).onDestroy(() => clearInterval(timer));
	}

	/** How much is unsaved and for how long. Null for an empty, untouched document. */
	readonly saveState = computed((): { text: string; title: string; dirty: boolean; warn: boolean } | null => {
		const now = this.now();
		const savedAt = this.docs.savedAt();
		if (!this.docs.dirty()) {
			if (savedAt) return { text: `Saved ${clock(savedAt)}`, title: `Everything is saved. Last saved at ${clock(savedAt)}.`, dirty: false, warn: false };
			return this.docs.file().name ? { text: 'No changes', title: 'No changes since the file was opened.', dirty: false, warn: false } : null;
		}
		const n = this.docs.touched().size;
		const since = this.docs.dirtySince() ?? now;
		const age = now - since;
		const what = n ? `${n} change${n === 1 ? '' : 's'}` : 'Unsaved changes';
		const text = age < 60e3 ? `${what}, not saved` : `${what}, unsaved for ${ago(age)}`;
		const detail = n ? `${n} paragraph${n === 1 ? '' : 's'} or settings edited` : 'The document has unsaved changes';
		const last = savedAt ? ` Last saved at ${clock(savedAt)}.` : ' Not saved in this session yet.';
		return { text, title: `${detail} since ${clock(since)}.${last} Click to save (${MOD}+S).`, dirty: true, warn: age >= WARN_AFTER_MIN * 60e3 || n >= WARN_AFTER_CHANGES };
	});

	/** Ancestor section titles shown as plain context before the section crumb. */
	readonly context = computed(() => {
		const s = this.editor.currentSection();
		const all = this.editor.structure().sections;
		const out: string[] = [];
		for (let p = s ? s.parent : -1; p >= 0; p = all[p].parent) out.unshift(all[p].title);
		return out;
	});

	readonly crumbs = computed((): Crumb[] => {
		const s = this.editor.currentSection();
		const b = this.editor.currentBlock();
		const sent = this.editor.sentence();
		const out: Crumb[] = [{ layer: 'document', label: this.editor.title() }];
		if (s) out.push({ layer: 'section', label: s.head !== null ? s.title : 'Opening' });
		out.push({ layer: 'paragraph', label: b && b.n && s ? `¶ ${b.n} of ${s.paras.length}` : b && b.type.startsWith('h') ? 'Heading' : 'Paragraph' });
		out.push({ layer: 'sentence', label: b && b.n && sent.count ? `Sentence ${sent.index + 1} of ${sent.count}` : 'Sentence' });
		return out;
	});

	readonly status = computed((): { text: string; kind: 'ok' | 'busy' | 'err' | '' ; title: string } => {
		const a = this.settings.ai();
		const running = this.ai.running();
		const queued = this.ai.queued();
		const err = this.ai.lastError();
		const title = err ? `${err} (open the model settings)` : 'Model settings';
		if (!a.enabled) return { text: 'AI off', kind: '', title };
		if (!a.model) return { text: 'Choose a model', kind: 'err', title };
		if (this.ai.offline()) return { text: 'Model unreachable', kind: 'err', title };
		if (running.length) return { text: `Reading ${running[0].label}${queued ? `, ${queued} waiting` : ''}`, kind: 'busy', title };
		if (queued) return { text: `Paused while you type, ${queued} waiting`, kind: 'busy', title };
		if (err) return { text: 'Last reading failed', kind: 'err', title };
		return { text: 'Up to date', kind: 'ok', title };
	});

	setLayer(layer: Layer): void { this.editor.setLayer(layer); this.editor.refocus(); }
	setType(value: string): void {
		const types: readonly TextBlockType[] = ['p', 'h1', 'h2', 'h3', 'ul', 'ol'];
		const t = types.find(x => x === value);
		if (t) this.editor.changeBlockType(t);
	}
	toggleMap(): void { this.ui.toggleMap(); }
	toggleLens(): void { this.ui.toggleLens(); }
}
