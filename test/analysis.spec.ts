import { describe, expect, it } from 'vitest';
import { fixture } from '#fixtures';
import { readDocument } from '../src/app/core/formats/formats';
import { parseEmbeddedData, parseReading } from '../src/app/core/analysis/readings';
import { buildStructure } from '../src/app/core/analysis/structure';
import { EMPTY_DOC_SETTINGS, type Block } from '../src/app/core/model';
import { findQuote, localChecks, quoteLength, sentencesOf } from '../src/app/core/text/text';
import { textOf } from './support/helpers';

const inputs = (blocks: readonly Block[]) => blocks.map((b, i) => ({ bid: `b${i}`, type: b.type, text: b.type === 'opaque' ? '' : b.runs.map(r => (r.kind === 'text' ? r.t : '')).join('') }));

describe('readings', () => {
	it('clamps and cleans loose model output', () => {
		const r = parseReading('para', { gist: '  g ', clarity: 9, issues: [{ type: 'bogus', quote: 'x' }, { type: 'cut', quote: '' }] });
		expect(r).toEqual({ kind: 'para', gist: 'g', flow: '', clarity: 5, issues: [{ type: 'change', quote: 'x', suggestion: '', note: '' }] });
	});
	it('keeps a missing section number as null', () => {
		const r = parseReading('doc', { thread: 't', cohesion: '71', feedback: [{ kind: 'question', text: 'Why?', section: null }] });
		expect(r?.kind === 'doc' && r.feedback[0].section).toBe(null);
		expect(r?.kind === 'doc' && r.cohesion).toBe(71);
	});
	it('rejects data that is not ours', () => {
		expect(parseEmbeddedData({ app: 'Other' })).toBe(null);
		expect(parseEmbeddedData('nope')).toBe(null);
	});
});

describe('compatibility with files saved by the single-file editor', () => {
	it('finds every stored reading for an unchanged file', async () => {
		const doc = await readDocument('a.docx', await fixture('v1-with-readings.docx'));
		const data = parseEmbeddedData(doc.data);
		if (!data) throw new Error('expected embedded data');
		const s = buildStructure(inputs(doc.blocks), data.settings);
		const wanted = [...s.blocks.map(b => b.paraKey), ...s.sections.map(x => x.key), s.docKey].filter((k): k is string => !!k);
		expect(wanted.length).toBeGreaterThan(8);
		expect(wanted.filter(k => !data.cache[k])).toEqual([]);
	});
	it('needs new readings only for what changed elsewhere', async () => {
		const doc = await readDocument('a.docx', await fixture('v1-edited-elsewhere.docx'));
		const data = parseEmbeddedData(doc.data);
		if (!data) throw new Error('expected embedded data');
		const s = buildStructure(inputs(doc.blocks), data.settings);
		const missingParas = s.blocks.filter(b => b.paraKey && !data.cache[b.paraKey]).map(b => b.text.slice(0, 20));
		expect(missingParas).toEqual(['Workers also met in ', 'A new closing paragr']);
		expect(s.sections.filter(x => x.key && !data.cache[x.key]).map(x => x.title)).toEqual(['Solidarity as practice', 'Part II: Democracy']);
	});
});

describe('structure', () => {
	it('nests sections and numbers paragraphs per section', async () => {
		const doc = await readDocument('a.docx', await fixture('libreoffice.docx'));
		const s = buildStructure(inputs(doc.blocks), EMPTY_DOC_SETTINGS);
		expect(s.sections.map(x => `${x.level}:${x.title}:${x.paras.length}:${x.parent}`)).toEqual(['1:Introduction:2:-1', '2:The social:5:0', '2:Democracy:1:0']);
		expect(s.blocks.filter(b => b.section === 1).map(b => b.n)).toEqual([0, 1, 2, 3, 4, 5, 0]);
		expect(textOf(doc.blocks[9])).toBe('[Table]');
	});
	it('changes paragraph keys when the style guide changes, and section keys when the line changes', () => {
		const blocks = [{ bid: 'a', type: 'p' as const, text: 'A paragraph that is long enough to be read.' }];
		const a = buildStructure(blocks, EMPTY_DOC_SETTINGS);
		const b = buildStructure(blocks, { ...EMPTY_DOC_SETTINGS, style: 'terse' });
		const c = buildStructure(blocks, { ...EMPTY_DOC_SETTINGS, thread: 'a line' });
		expect(a.blocks[0].paraKey === b.blocks[0].paraKey).toBe(false);
		expect(a.blocks[0].paraKey === c.blocks[0].paraKey).toBe(true);
		expect(a.sections[0].key === c.sections[0].key).toBe(false);
	});
});

describe('text checks', () => {
	it('finds quotes despite curly quotes, dashes and spacing', () => {
		const text = 'He said “social”  democracy — twice.';
		const at = findQuote(text, 'said "social" democracy - twice');
		expect(at).toBe(3);
		expect(text.slice(at, at + quoteLength(text, at, 'said "social" democracy - twice'))).toBe('said “social”  democracy — twice');
	});
	it('flags close repeats but not keywords or function words', () => {
		const c = localChecks('Solidarity matters. Solidarity is practice, and there there is more.', ['practice']);
		expect(c.repeats.map(r => r.word)).toEqual(['solidarity']);
		expect(c.doubled.map(d => d.word)).toEqual(['there']);
	});
	it('splits sentences', () => {
		expect(sentencesOf('One. Two? Three!').length).toBe(3);
	});
});
