/** Markdown reader and writer for the subset the editor supports. */
import type { Block, Run, SaveBlock } from '../model';
import { mergeRuns, textRun } from '../util/runs';

interface Fmt { b: boolean; i: boolean; href: string | null }
const INLINE = /\*\*(.+?)\*\*|__(.+?)__|\*(?![\s*])(.+?)\*|(?<![\p{L}\p{N}])_(?![\s_])(.+?)_(?![\p{L}\p{N}])|\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|`([^`]+)`|\\([\\`*_{}[\]()#+\-.!>])/gu;

/** Parses inline Markdown: bold, italic, links, code (as plain text) and escapes. */
export function parseInline(s: string, f: Fmt = { b: false, i: false, href: null }, out: Run[] = []): Run[] {
	const re = new RegExp(INLINE.source, INLINE.flags);
	let last = 0;
	for (let m = re.exec(s); m; m = re.exec(s)) {
		if (m.index > last) out.push(textRun(s.slice(last, m.index), f));
		if (m[1] ?? m[2]) parseInline(m[1] ?? m[2], { ...f, b: true }, out);
		else if (m[3] ?? m[4]) parseInline(m[3] ?? m[4], { ...f, i: true }, out);
		else if (m[5]) parseInline(m[5], { ...f, href: m[6] }, out);
		else out.push(textRun(m[7] ?? m[8] ?? '', f));
		last = re.lastIndex;
	}
	if (last < s.length) out.push(textRun(s.slice(last), f));
	return out;
}

export function readMarkdown(source: string): Block[] {
	const blocks: Block[] = [];
	let para: string[] = [];
	const flush = (): void => { if (para.length) { blocks.push({ type: 'p', runs: mergeRuns(parseInline(para.join(' '))), meta: null }); para = []; } };
	const lines = source.replace(/\r\n?/g, '\n').replace(/^---\n[\s\S]*?\n---\n/, '').split('\n');
	for (const line of lines) {
		let m: RegExpExecArray | null;
		if (!line.trim()) { flush(); continue; }
		if ((m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line))) {
			flush();
			blocks.push({ type: m[1].length === 1 ? 'h1' : m[1].length === 2 ? 'h2' : 'h3', runs: mergeRuns(parseInline(m[2])), meta: null });
			continue;
		}
		if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); continue; }
		if ((m = /^\s*[-*+]\s+(.*)$/.exec(line))) { flush(); blocks.push({ type: 'ul', runs: mergeRuns(parseInline(m[1])), meta: null }); continue; }
		if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) { flush(); blocks.push({ type: 'ol', runs: mergeRuns(parseInline(m[1])), meta: null }); continue; }
		if ((m = /^>\s?(.*)$/.exec(line))) { para.push(m[1].trim()); continue; }
		para.push(/ {2}$/.test(line) ? `${line.trim()}\n` : line.trim());
	}
	flush();
	return blocks.map(b => (b.type === 'opaque' ? b : { ...b, runs: b.runs.map(r => (r.kind === 'text' ? { ...r, t: r.t.replace(/\n /g, '\n') } : r)) }));
}

function inlineMarkdown(runs: readonly Run[]): string {
	let out = '';
	for (const r of runs) {
		if (r.kind === 'token') continue;
		const t = r.t.replace(/([\\*`[\]])/g, '\\$1').replace(/\n/g, '  \n');
		const lead = /^\s*/.exec(t)?.[0] ?? '';
		const trail = /\s*$/.exec(t)?.[0] ?? '';
		let core = t.slice(lead.length, t.length - trail.length);
		if (!core) { out += t; continue; }
		if (r.b && r.i) core = `***${core}***`;
		else if (r.b) core = `**${core}**`;
		else if (r.i) core = `*${core}*`;
		if (r.href) core = `[${core}](${r.href.replace(/[ ()]/g, c => encodeURIComponent(c))})`;
		out += lead + core + trail;
	}
	return out;
}

export function writeMarkdown(blocks: readonly SaveBlock[]): string {
	const out: string[] = [];
	let n = 0;
	let prev: string | null = null;
	for (const b of blocks) {
		if (b.type === 'opaque') continue;
		const t = inlineMarkdown(b.runs);
		if (b.type === 'ul' || b.type === 'ol') {
			n = prev === b.type ? n + 1 : 1;
			const line = (b.type === 'ul' ? '- ' : `${n}. `) + t;
			if (prev === b.type) out[out.length - 1] += `\n${line}`;
			else out.push(line);
		} else {
			out.push(b.type === 'p' ? t : `${'#'.repeat(Number(b.type[1]))} ${t}`);
		}
		prev = b.type;
	}
	return `${out.join('\n\n').trim()}\n`;
}
