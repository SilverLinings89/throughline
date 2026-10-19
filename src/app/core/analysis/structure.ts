/**
 * Document structure: sections, paragraph numbering and reading keys.
 * Pure function of the block list and document settings, so it is cheap to test and to recompute.
 */
import type { BlockType, DocSettings } from '../model';
import { hash } from '../util/hash';
import { PROMPT_VERSION } from './prompts';

/** Paragraphs shorter than this are listed in their section but get no paragraph reading. */
export const MIN_READ_LENGTH = 25;

export interface BlockInput { readonly bid: string; readonly type: BlockType; readonly text: string }
export interface StructBlock extends BlockInput {
	readonly index: number;
	/** Hash of the trimmed text. */
	readonly hash: string;
	/** Index of the section that contains the block. */
	readonly section: number;
	/** 1-based paragraph number within the section, 0 for headings and kept items. */
	readonly n: number;
	/** Cache key of the paragraph reading, or null when the block is not read. */
	readonly paraKey: string | null;
}
export interface Section {
	readonly index: number;
	/** Block index of the heading, or null for the opening before the first heading. */
	readonly head: number | null;
	readonly level: 1 | 2 | 3;
	readonly title: string;
	readonly parent: number;
	readonly depth: number;
	/** Block indexes of the section's own paragraphs, headings of subsections excluded. */
	readonly paras: number[];
	readonly pathText: string;
	/** Hash of the lowercase title, used to find the last reading of an edited section. */
	readonly titleKey: string;
	/** Cache key of the section reading, or null when the section has no paragraphs. */
	readonly key: string | null;
	readonly children: number[];
}
export interface Structure {
	readonly blocks: readonly StructBlock[];
	readonly sections: readonly Section[];
	readonly indexOf: ReadonlyMap<string, number>;
	/** Cache key of the whole-document reading, or null when no section has paragraphs. */
	readonly docKey: string | null;
}
export const EMPTY_STRUCTURE: Structure = { blocks: [], sections: [], indexOf: new Map(), docKey: null };

const isHeading = (t: BlockType): t is 'h1' | 'h2' | 'h3' => t === 'h1' || t === 'h2' || t === 'h3';

export function buildStructure(inputs: readonly BlockInput[], settings: DocSettings): Structure {
	const styleHash = hash(`${PROMPT_VERSION}|${settings.style}|${settings.language}`);
	const threadHash = hash(settings.thread);
	type MutableSection = Omit<Section, 'key' | 'children' | 'titleKey'> & { paras: number[] };
	const sections: MutableSection[] = [];
	const stack: MutableSection[] = [];
	const blocks: StructBlock[] = [];
	let cur: MutableSection | null = null;
	inputs.forEach((input, index) => {
		const h = hash(input.text.trim());
		if (isHeading(input.type)) {
			const level = input.type === 'h1' ? 1 : input.type === 'h2' ? 2 : 3;
			while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
			const title = input.text.trim() || 'Untitled heading';
			cur = { index: sections.length, head: index, level, title, parent: stack.length ? stack[stack.length - 1].index : -1, depth: stack.length, paras: [], pathText: [...stack.map(s => s.title), title].join(' > ') };
			stack.push(cur);
			sections.push(cur);
			blocks.push({ ...input, index, hash: h, section: cur.index, n: 0, paraKey: null });
			return;
		}
		if (!cur) {
			cur = { index: 0, head: null, level: 1, title: 'Opening', parent: -1, depth: 0, paras: [], pathText: 'Opening, before the first heading' };
			sections.push(cur);
		}
		let n = 0;
		let paraKey: string | null = null;
		if (input.type !== 'opaque' && input.text.trim()) {
			cur.paras.push(index);
			n = cur.paras.length;
			if (input.text.trim().length >= MIN_READ_LENGTH) paraKey = `p:${h}:${styleHash}`;
		}
		blocks.push({ ...input, index, hash: h, section: cur.index, n, paraKey });
	});
	const done: Section[] = sections.map(s => ({
		...s,
		titleKey: hash(s.title.toLowerCase()),
		key: s.paras.length ? `s:${hash(`${s.title}\n${s.paras.map(i => blocks[i].hash).join(',')}\n${threadHash}|${PROMPT_VERSION}`)}` : null,
		children: sections.filter(c => c.parent === s.index).map(c => c.index),
	}));
	const keyed = done.filter(s => s.key);
	return {
		blocks, sections: done, indexOf: new Map(blocks.map(b => [b.bid, b.index])),
		docKey: keyed.length ? `d:${hash(`${keyed.map(s => s.key).join(',')}|${threadHash}|${styleHash}`)}` : null,
	};
}
