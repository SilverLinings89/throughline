import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import type { LocatedIssue } from '../../core/analysis/issues';
import { LONG_SENTENCE } from '../../core/text/text';
import { AiClient } from '../../services/ai-client';
import { AnalysisService } from '../../services/analysis.service';
import { DocumentStore } from '../../services/document.store';
import { EditorService, type FilterKey } from '../../services/editor.service';

const LABEL: Record<FilterKey, string> = { cut: 'Cut', change: 'Change', ambiguous: 'Unclear', repetition: 'Repeated', style: 'Style', local: 'Close repeats' };
const ORDER: readonly FilterKey[] = ['cut', 'change', 'ambiguous', 'repetition', 'style', 'local'];

/** Right column: one paragraph up close. Suggestions, scores, quick checks and sentences. */
@Component({
	selector: 'tl-lens',
	changeDetection: ChangeDetectionStrategy.OnPush,
	templateUrl: './lens-panel.html',
	host: { id: 'lens', class: 'lens', role: 'complementary', 'aria-label': 'Paragraph lens' },
})
export class LensPanel {
	readonly editor = inject(EditorService);
	readonly analysis = inject(AnalysisService);
	private readonly docs = inject(DocumentStore);
	private readonly ai = inject(AiClient);
	readonly ready = this.ai.ready;
	readonly long = LONG_SENTENCE;

	readonly view = computed(() => {
		const ins = this.analysis.inspection();
		if (!ins) return null;
		const filters = this.editor.filters();
		const counts = new Map<FilterKey, number>();
		for (const i of ins.issues) counts.set(i.type, (counts.get(i.type) ?? 0) + 1);
		if (ins.checks.repeats.length) counts.set('local', ins.checks.repeats.length);
		const maxWords = Math.max(1, ...ins.checks.sentences.map(s => s.words));
		const scores: { label: string; value: number; note: string }[] = [];
		if (ins.para?.reading.clarity) scores.push({ label: 'Clarity', value: ins.para.reading.clarity, note: '' });
		if (ins.fit?.fit) scores.push({ label: 'Serves the section', value: ins.fit.fit, note: ins.fit.fit <= 3 ? ins.fit.note : '' });
		if (ins.fit?.bridge) scores.push({ label: ins.block.n === 1 ? 'Opens the section' : `Follows from ¶ ${ins.block.n - 1}`, value: ins.fit.bridge, note: ins.fit.bridge <= 3 && (ins.fit.fit ?? 5) > 3 ? ins.fit.note : '' });
		return {
			...ins,
			scores,
			filters: ORDER.filter(k => counts.has(k)).map(k => ({ key: k, label: LABEL[k], count: counts.get(k) ?? 0, on: filters[k] })),
			shown: ins.issues.filter(i => filters[i.type]),
			sentences: ins.checks.sentences.map((s, i) => ({ ...s, i, bar: Math.round(8 + (52 * s.words) / maxWords) })),
			repeats: filters.local ? ins.checks.repeats : [],
		};
	});

	readonly sentenceIndex = computed(() => this.editor.sentence().index);

	close(): void { this.editor.lensOpen.set(false); this.editor.refocus(); }
	toggle(key: FilterKey): void { this.editor.filters.update(f => ({ ...f, [key]: !f[key] })); }
	pips(n: number): boolean[] { return [1, 2, 3, 4, 5].map(i => i <= n); }
	canApply(i: LocatedIssue): boolean { return i.type === 'cut' || (!!i.suggestion && i.type !== 'ambiguous'); }
	apply(i: LocatedIssue): void { const v = this.view(); if (v) this.editor.applyIssue(v.block.bid, i); }
	ignore(i: LocatedIssue): void { this.docs.ignore(i.id); }
	show(i: LocatedIssue): void { const v = this.view(); if (v) this.editor.selectText(v.block.bid, i); }
	hover(id: string | null): void { this.editor.hoverIssue.set(id); }
	selectSentence(i: number): void {
		const v = this.view();
		const s = v?.sentences[i];
		if (v && s) this.editor.selectText(v.block.bid, s);
	}
	readAgain(): void { this.analysis.readCurrent(true); }
}
