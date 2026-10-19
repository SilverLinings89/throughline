import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import type { DocFormat } from '../../core/model';
import { firstWords } from '../../core/util/strings';
import { AnalysisService } from '../../services/analysis.service';
import { DocumentStore } from '../../services/document.store';
import { EditorService } from '../../services/editor.service';
import { FilesService } from '../../services/files.service';
import { UiState } from '../../services/ui-state';
import { DeskPanel } from '../desk/desk-panel';

interface Gist { readonly bid: string; readonly text: string; readonly raw: boolean; readonly done: boolean; readonly weak: boolean; readonly off: boolean; readonly here: boolean; readonly tip: string; readonly indent: number }
interface OutlineNode {
	readonly index: number; readonly title: string; readonly level: number; readonly indent: number;
	readonly here: boolean; readonly onPath: boolean; readonly keywords: string; readonly stale: boolean;
	readonly cohesion: number | null; readonly gists: readonly Gist[];
}

/** Left column: file actions, title, main line, outline with the thread, and the desk. */
@Component({
	selector: 'tl-map',
	changeDetection: ChangeDetectionStrategy.OnPush,
	imports: [DeskPanel],
	templateUrl: './map-panel.html',
	host: { id: 'map', role: 'complementary', 'aria-label': 'Map of the document' },
})
export class MapPanel {
	readonly editor = inject(EditorService);
	readonly docs = inject(DocumentStore);
	readonly files = inject(FilesService);
	readonly ui = inject(UiState);
	private readonly analysis = inject(AnalysisService);
	readonly menuOpen = signal(false);
	readonly formats: readonly { readonly format: DocFormat; readonly label: string }[] = [
		{ format: 'docx', label: 'Save as Word (.docx)' }, { format: 'odt', label: 'Save as OpenDocument (.odt)' },
		{ format: 'md', label: 'Save as Markdown (.md)' }, { format: 'txt', label: 'Save as plain text (.txt)' },
	];

	readonly thread = computed(() => ({ own: this.docs.settings().thread, reads: this.analysis.docReading()?.reading.thread ?? '' }));

	readonly nodes = computed((): OutlineNode[] => {
		const s = this.editor.structure();
		const pos = this.editor.position();
		const path = new Set<number>();
		for (let i = pos.section; i >= 0; i = s.sections[i]?.parent ?? -1) path.add(i);
		const out: OutlineNode[] = [];
		for (const sec of s.sections) {
			if (sec.head === null && !sec.paras.length) continue;
			const r = this.analysis.sectionReading(sec);
			let keywords = r?.reading.keywords ?? [];
			let stale = r?.stale ?? false;
			if (!keywords.length && sec.children.length) {
				const collected: string[] = [];
				const walk = (i: number): void => {
					for (const c of s.sections[i].children) {
						for (const w of (this.analysis.sectionReading(s.sections[c])?.reading.keywords ?? []).slice(0, 2)) if (!collected.includes(w)) collected.push(w);
						walk(c);
					}
				};
				walk(sec.index);
				keywords = collected.slice(0, 6);
				stale = true;
			}
			const here = sec.index === pos.section;
			const fits = new Map((r?.reading.paragraphs ?? []).map(p => [p.n, p]));
			const gists: Gist[] = here ? sec.paras.map(i => {
				const b = s.blocks[i];
				const para = this.analysis.paraReading(b);
				const fit = fits.get(b.n);
				const weak = !!fit?.bridge && fit.bridge <= 2 && b.n > 1;
				const off = !!fit?.fit && fit.fit <= 2;
				return {
					bid: b.bid, text: para?.reading.gist || firstWords(b.text, 9), raw: !para?.reading.gist, done: !!para && !para.stale,
					weak, off, here: b.index === pos.index, indent: (sec.depth + 1) * 12,
					tip: [fit?.note ?? '', off ? 'Strays from the section' : '', weak ? 'Weak link to the paragraph before' : ''].filter(Boolean).join('. '),
				};
			}) : [];
			out.push({ index: sec.index, title: sec.title, level: sec.level, indent: sec.depth * 12, here, onPath: path.has(sec.index) && !here, keywords: keywords.join(', '), stale, cohesion: here ? r?.reading.cohesion ?? null : null, gists });
		}
		return out;
	});

	readonly fewParagraphs = computed(() => { const s = this.editor.structure(); return s.sections.length <= 1 && (s.sections[0]?.head ?? null) === null && (s.sections[0]?.paras.length ?? 0) < 2; });

	jumpToSection(index: number): void {
		const s = this.editor.structure();
		const sec = s.sections[index];
		const target = sec?.head ?? sec?.paras[0];
		if (target !== undefined && target !== null) this.go(s.blocks[target].bid);
	}
	go(bid: string): void {
		this.editor.jumpTo(bid);
		if (this.ui.narrow()) this.ui.mapOverlayOpen.set(false);
	}
	adoptThread(): void { const t = this.thread().reads; if (t) this.docs.updateSettings({ thread: t }); this.editor.reindex(); }
	saveAs(format: DocFormat): void { this.menuOpen.set(false); void this.files.save(format); }
}
