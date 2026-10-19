/** Plain text: blank lines separate paragraphs; without blank lines, each line is a paragraph. */
import type { Block, SaveBlock } from '../model';
import { runsText, textRun } from '../util/runs';

export function splitParagraphs(source: string): string[] {
	const text = source.replace(/\r\n?/g, '\n');
	const paras = /\n\s*\n/.test(text) ? text.split(/\n\s*\n/).map(p => p.replace(/\s*\n\s*/g, ' ')) : text.split('\n');
	return paras.map(p => p.trim()).filter(Boolean);
}

export function readPlainText(source: string): Block[] {
	return splitParagraphs(source).map(p => ({ type: 'p', runs: [textRun(p)], meta: null }));
}

export function writePlainText(blocks: readonly SaveBlock[]): string {
	let n = 0;
	let prev: string | null = null;
	const lines: string[] = [];
	for (const b of blocks) {
		if (b.type === 'opaque') continue;
		const t = runsText(b.runs);
		n = b.type === 'ol' && prev === 'ol' ? n + 1 : 1;
		prev = b.type;
		lines.push(b.type === 'ul' ? `- ${t}` : b.type === 'ol' ? `${n}. ${t}` : t);
	}
	return `${lines.join('\n\n')}\n`;
}
