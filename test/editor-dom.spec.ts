import { describe, expect, it } from 'vitest';
import { blockElements, domRuns, htmlToBlocks, normalizeEditor, renderBlocks, setBlockType, signature, typeOf, selectRange, rangeFor } from '../src/app/core/editor/dom';
import { textRun } from '../src/app/core/util/runs';
import type { Block } from '../src/app/core/model';

function editor(html = ''): HTMLElement {
	const el = document.createElement('div');
	el.contentEditable = 'true';
	el.innerHTML = html;
	document.body.appendChild(el);
	return el;
}

describe('editor DOM', () => {
	it('renders blocks and reads the same runs back', () => {
		const blocks: Block[] = [
			{ type: 'h2', runs: [textRun('Head')], meta: null },
			{ type: 'p', runs: [textRun('a '), textRun('bold', { b: true }), textRun(' link', { href: 'https://x.org', i: true }), { kind: 'token', fmt: 'docx', xml: '<w:r/>', label: '1' }], meta: null },
			{ type: 'ul', runs: [textRun('one')], meta: null },
			{ type: 'ul', runs: [textRun('two\nlines')], meta: null },
		];
		const root = editor();
		renderBlocks(root, blocks, ['a', 'b', 'c', 'd']);
		const els = blockElements(root);
		expect(els.map(typeOf)).toEqual(['h2', 'p', 'ul', 'ul']);
		expect(els.map(e => signature(typeOf(e), domRuns(e)))).toEqual(blocks.map(b => signature(b.type, b.type === 'opaque' ? [] : b.runs)));
		root.remove();
	});

	it('flattens a list Chrome nested inside a paragraph', () => {
		// The HTML parser cannot produce this nesting; Chrome's list command builds it through the DOM.
		const root = editor('<p data-bid="a">Hello</p><p data-bid="b"></p>');
		const ol = document.createElement('ol');
		ol.innerHTML = '<li>first</li>';
		root.children[1].appendChild(ol);
		expect(normalizeEditor(root)).toBe(true);
		expect(root.innerHTML).toBe('<p data-bid="a">Hello</p><ol><li>first</li></ol>');
		root.remove();
	});

	it('wraps stray text and turns divs into paragraphs', () => {
		const root = editor('loose text<div>a div</div><h5>small</h5>');
		normalizeEditor(root);
		expect(blockElements(root).map(e => `${e.tagName}:${e.textContent}`)).toEqual(['P:loose text', 'P:a div', 'H3:small']);
		root.remove();
	});

	it('converts paragraphs to a list and back without nesting', () => {
		const root = editor('<p data-bid="a">one</p><p data-bid="b">two</p>');
		const [a, b] = blockElements(root);
		const r = document.createRange();
		r.setStart(a.firstChild ?? a, 0); r.setEnd(b.firstChild ?? b, 1);
		selectRange(r);
		setBlockType(root, 'ol');
		expect(root.innerHTML).toBe('<ol><li data-bid="a">one</li><li data-bid="b">two</li></ol>');
		selectRange(rangeFor(blockElements(root)[0], 0, 0));
		setBlockType(root, 'ul');
		expect(root.innerHTML).toBe('<ul><li data-bid="a">one</li></ul><ol><li data-bid="b">two</li></ol>');
		root.remove();
	});

	it('cleans pasted HTML from Word and Google Docs', () => {
		const html = '<p class=MsoNormal><span style="mso-list:Ignore">·</span><b>Bold</b> and <i>it</i></p><b style="font-weight:normal" id="docs-internal-guid-1"><span style="font-weight:700">G</span> plain</b><ul><li>x</li></ul><script>alert(1)</script>';
		const blocks = htmlToBlocks(html);
		expect(blocks.map(b => `${b.type}:${b.type === 'opaque' ? '' : b.runs.map(r => (r.kind === 'text' ? (r.b ? `*${r.t}*` : r.i ? `_${r.t}_` : r.t) : '')).join('')}`))
			.toEqual(['p:*Bold* and _it_', 'p:*G* plain', 'ul:x']);
	});
});
