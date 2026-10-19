import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import type { FeedbackKind } from '../../core/analysis/readings';
import { hash } from '../../core/util/hash';
import { AiClient } from '../../services/ai-client';
import { AnalysisService } from '../../services/analysis.service';
import { DocumentStore } from '../../services/document.store';
import { EditorService } from '../../services/editor.service';
import { SettingsStore } from '../../services/settings.store';
import { UiState, type DeskTab } from '../../services/ui-state';

type NoteKind = FeedbackKind | 'section';
interface Note { readonly id: string; readonly kind: NoteKind; readonly label: string; readonly text: string; readonly section: number | null; readonly sectionTitle: string }
const KIND_LABEL: Record<NoteKind, string> = { structure: 'Structure', idea: 'Idea', source: 'Source to check', question: 'A reader might ask', section: 'For this section' };

/** Turns a cohesion score into words. */
export function verdict(c: number): string {
	return c >= 80 ? 'Tight' : c >= 60 ? 'Holds together' : c >= 40 ? 'Loose in places' : 'Breaks apart in places';
}

/** Bottom of the map: how the section holds together, notes from the model, and the chat. */
@Component({
	selector: 'tl-desk',
	changeDetection: ChangeDetectionStrategy.OnPush,
	templateUrl: './desk-panel.html',
	host: { class: 'desk', '[class.short]': 'settings.editor().deskFolded' },
})
export class DeskPanel {
	readonly ui = inject(UiState);
	readonly settings = inject(SettingsStore);
	private readonly analysis = inject(AnalysisService);
	private readonly editor = inject(EditorService);
	private readonly docs = inject(DocumentStore);
	private readonly ai = inject(AiClient);
	readonly verdict = verdict;
	readonly tabs: readonly { readonly id: DeskTab; readonly label: string }[] = [{ id: 'line', label: 'Line' }, { id: 'notes', label: 'Notes' }, { id: 'ask', label: 'Ask' }];

	/** Why there is no reading yet, in words the user can act on. */
	readonly hint = computed(() => {
		const a = this.settings.ai();
		if (!a.enabled) return 'Background reading is switched off in the settings.';
		if (!a.model) return 'Choose a model in the settings to get feedback here. Everything runs on your machine.';
		if (this.ai.offline()) return 'The model server cannot be reached. Check the address in the settings.';
		return 'Waiting for the model to read this.';
	});

	readonly line = computed(() => {
		const s = this.editor.currentSection();
		const structure = this.editor.structure();
		const sec = s ? this.analysis.sectionReading(s) : null;
		const doc = this.analysis.docReading();
		return {
			section: s ? {
				index: s.index, title: s.head !== null ? s.title : 'Opening', empty: !s.paras.length, reading: sec?.reading ?? null, stale: sec?.stale ?? false,
				breaks: (sec?.reading.breaks ?? []).map(b => ({ ...b, bid: structure.blocks[s.paras[b.n - 1]]?.bid ?? null })),
			} : null,
			doc: doc ? { cohesion: doc.reading.cohesion, stale: doc.stale } : null,
			docPending: !doc && structure.sections.filter(x => x.key).length >= 2,
		};
	});

	readonly notes = computed((): { visible: Note[]; total: number; stale: boolean } => {
		const listed = this.analysis.listedSections();
		const doc = this.analysis.docReading();
		const all: Note[] = [];
		for (const f of doc?.reading.feedback ?? []) {
			const sec = f.section ? listed[f.section - 1] ?? null : null;
			all.push({ id: hash(f.text), kind: f.kind, label: KIND_LABEL[f.kind], text: f.text, section: sec?.index ?? null, sectionTitle: sec?.title ?? '' });
		}
		const s = this.editor.currentSection();
		const r = s ? this.analysis.sectionReading(s) : null;
		for (const t of r?.reading.suggestions ?? []) all.push({ id: hash(t), kind: 'section', label: KIND_LABEL.section, text: t, section: s?.index ?? null, sectionTitle: '' });
		const dismissed = this.docs.dismissed();
		return { visible: all.filter(n => !dismissed.has(n.id)), total: all.length, stale: !!doc?.stale };
	});

	select(tab: DeskTab): void {
		this.ui.deskTab.set(tab);
		if (this.settings.editor().deskFolded) this.settings.updateEditor({ deskFolded: false });
	}
	toggleFold(): void { this.settings.updateEditor({ deskFolded: !this.settings.editor().deskFolded }); }
	jump(bid: string | null): void { if (bid) this.editor.jumpTo(bid, { lens: true }); }
	jumpToSection(index: number | null): void {
		if (index === null) return;
		const s = this.editor.structure();
		const sec = s.sections[index];
		const target = sec?.head ?? sec?.paras[0];
		if (target !== undefined && target !== null) this.editor.jumpTo(s.blocks[target].bid);
	}
	hide(id: string): void { this.docs.dismiss(id); }

	send(input: HTMLTextAreaElement): void {
		if (!this.ai.ready()) { this.ui.openSettings('ai'); return; }
		if (this.analysis.ask(input.value)) { input.value = ''; input.style.height = ''; }
	}
	onKey(e: KeyboardEvent, input: HTMLTextAreaElement): void {
		if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); this.send(input); }
	}
	grow(input: HTMLTextAreaElement): void { input.style.height = ''; input.style.height = `${Math.min(120, input.scrollHeight)}px`; }
}
