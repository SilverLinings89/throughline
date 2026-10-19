import { describe, expect, it } from 'vitest';
import { DOC_MIN_INTERVAL, docChanged, editSize, sectionBasis, sectionChanged } from '../src/app/core/analysis/refresh';

const para = (hash: string, length: number, text = hash) => ({ hash, text: text.repeat(Math.ceil(length / text.length)).slice(0, length) });
const base = sectionBasis([para('a', 400), para('b', 400), para('c', 400), para('d', 400)], 'sig');

describe('when a section is read again', () => {
	it('keeps the reading through small edits', () => {
		const edited = para('b', 400).text.slice(0, 200) + ' a few new words ' + para('b', 400).text.slice(200);
		expect(sectionChanged(base, sectionBasis([para('a', 400), { hash: 'b2', text: edited }, para('c', 400), para('d', 400)], 'sig'))).toBe(false);
	});
	it('measures an edit by what differs between the versions', () => {
		expect(editSize('the cat sat', 'the dog sat')).toBe(3);
		expect(editSize('', 'abc')).toBe(3);
	});
	it('reads again after a quarter of the text changed, two paragraphs came or went, or the settings changed', () => {
		expect(sectionChanged(base, sectionBasis([para('a2', 400, 'q'), para('b2', 400, 'r'), para('c', 400), para('d', 400)], 'sig'))).toBe(true);
		expect(sectionChanged(base, sectionBasis([para('a', 400), para('b', 400)], 'sig'))).toBe(true);
		expect(sectionChanged(base, sectionBasis([para('a', 400), para('b', 400), para('c', 400), para('d', 400)], 'new line'))).toBe(true);
	});
	it('reads again when nothing is known about the earlier reading', () => {
		expect(sectionChanged(undefined, base)).toBe(true);
	});
});

describe('when the whole text is read again', () => {
	const then = { sig: 's', titles: 'A\nB\nC', freshSections: 0 };
	it('reads again when the settings or headings changed', () => {
		expect(docChanged(then, 's2', 'A\nB\nC', 3, 0)).toBe(true);
		expect(docChanged(then, 's', 'A\nB', 2, 0)).toBe(true);
	});
	it('waits for several new section readings and the minimum interval', () => {
		expect(docChanged({ ...then, freshSections: 1 }, 's', 'A\nB\nC', 3, DOC_MIN_INTERVAL)).toBe(false);
		expect(docChanged({ ...then, freshSections: 2 }, 's', 'A\nB\nC', 3, 60e3)).toBe(false);
		expect(docChanged({ ...then, freshSections: 2 }, 's', 'A\nB\nC', 3, DOC_MIN_INTERVAL)).toBe(true);
	});
});
