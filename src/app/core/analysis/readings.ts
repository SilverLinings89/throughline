/**
 * Model readings and how raw model output becomes one.
 * Local models return loose JSON, so every field is checked and clamped here, at the boundary.
 */
import { EMPTY_DOC_SETTINGS, type DocSettings } from '../model';
import { isLanguageTag } from '../text/lang';
import { clamp } from '../util/strings';

export const ISSUE_TYPES = ['cut', 'change', 'ambiguous', 'repetition', 'style'] as const;
export type IssueType = (typeof ISSUE_TYPES)[number];
export const FEEDBACK_KINDS = ['structure', 'idea', 'source', 'question'] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

export interface Issue { readonly type: IssueType; readonly quote: string; readonly suggestion: string; readonly note: string }
/** How one paragraph reads on its own. */
export interface ParaReading {
	readonly kind: 'para';
	readonly gist: string;
	readonly flow: string;
	readonly clarity: number | null;
	readonly issues: Issue[];
}
export interface ParagraphFit { readonly n: number; readonly fit: number | null; readonly bridge: number | null; readonly note: string }
/** How the paragraphs of one section hang together. */
export interface SectionReading {
	readonly kind: 'section';
	readonly keywords: string[];
	readonly summary: string;
	readonly line: string;
	readonly cohesion: number | null;
	readonly paragraphs: ParagraphFit[];
	readonly breaks: { readonly n: number; readonly note: string }[];
	readonly suggestions: string[];
}
export interface Feedback { readonly kind: FeedbackKind; readonly text: string; readonly section: number | null }
/** How the sections follow the main line. */
export interface DocReading {
	readonly kind: 'doc';
	readonly thread: string;
	readonly cohesion: number | null;
	readonly feedback: Feedback[];
}
export type Reading = ParaReading | SectionReading | DocReading;
export type ReadingKind = Reading['kind'];

type Dict = Record<string, unknown>;
const isDict = (v: unknown): v is Dict => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 400): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const num = (v: unknown, min: number, max: number): number | null => {
	if (v === null || v === undefined || v === '') return null;
	const x = Number(v);
	return Number.isFinite(x) ? clamp(Math.round(x), min, max) : null;
};
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const oneOf = <T extends string>(options: readonly T[], v: unknown, fallback: T): T => options.find(o => o === v) ?? fallback;

/** The reading kind a cache key stores: `p:` paragraph, `s:` section, `d:` document. */
export function kindOfKey(key: string): ReadingKind | null {
	return key.startsWith('p:') ? 'para' : key.startsWith('s:') ? 'section' : key.startsWith('d:') ? 'doc' : null;
}

/** Validates raw model output or stored data. Returns null when it cannot be used. */
export function parseReading(kind: ReadingKind, raw: unknown): Reading | null {
	if (!isDict(raw)) return null;
	switch (kind) {
		case 'para': return {
			kind, gist: str(raw['gist'], 140), flow: str(raw['flow']), clarity: num(raw['clarity'], 1, 5),
			issues: list(raw['issues']).filter(isDict).map(x => ({ type: oneOf(ISSUE_TYPES, x['type'], 'change'), quote: str(x['quote'], 300), suggestion: str(x['suggestion'], 300), note: str(x['note'], 300) })).filter(x => x.quote).slice(0, 12),
		};
		case 'section': return {
			kind, keywords: list(raw['keywords']).map(k => str(k, 40)).filter(Boolean).slice(0, 7),
			summary: str(raw['summary'], 300), line: str(raw['line'], 300), cohesion: num(raw['cohesion'], 0, 100),
			paragraphs: list(raw['paragraphs']).filter(isDict).map(p => ({ n: num(p['n'], 1, 9999) ?? 0, fit: num(p['fit'], 1, 5), bridge: num(p['bridge'], 1, 5), note: str(p['note'], 200) })).filter(p => p.n > 0),
			breaks: list(raw['breaks']).filter(isDict).map(b => ({ n: num(b['n'], 1, 9999) ?? 0, note: str(b['note'], 240) })).filter(b => b.n > 0 && b.note).slice(0, 8),
			suggestions: list(raw['suggestions']).map(s => str(isDict(s) ? s['text'] : s, 300)).filter(Boolean).slice(0, 4),
		};
		case 'doc': return {
			kind, thread: str(raw['thread']), cohesion: num(raw['cohesion'], 0, 100),
			feedback: list(raw['feedback']).filter(isDict).map(f => ({ kind: oneOf(FEEDBACK_KINDS, f['kind'], 'idea'), text: str(f['text'], 500), section: num(f['section'], 1, 9999) })).filter(f => f.text).slice(0, 10),
		};
		default: { const exhaustive: never = kind; return exhaustive; }
	}
}

/** Data stored inside a document file. Version 1 is also what the single-file editor wrote. */
export interface EmbeddedData {
	readonly app: 'Throughline';
	readonly v: 1;
	readonly saved: string;
	readonly settings: DocSettings;
	readonly cache: Record<string, Reading>;
	/** Section title hash → reading key, so an edited section still shows its last reading. */
	readonly secByTitle: Record<string, string>;
	readonly lastDoc: string | null;
	readonly ignored: string[];
	readonly dismissed: string[];
}

/** Validates embedded data from a file. Unknown or broken parts are dropped, not trusted. */
export function parseEmbeddedData(raw: unknown): EmbeddedData | null {
	if (!isDict(raw) || raw['app'] !== 'Throughline') return null;
	const s = isDict(raw['settings']) ? raw['settings'] : {};
	const cache: Record<string, Reading> = {};
	if (isDict(raw['cache'])) {
		for (const [key, value] of Object.entries(raw['cache'])) {
			const kind = kindOfKey(key);
			const r = kind ? parseReading(kind, value) : null;
			if (r) cache[key] = r;
		}
	}
	const secByTitle: Record<string, string> = {};
	if (isDict(raw['secByTitle'])) for (const [k, v] of Object.entries(raw['secByTitle'])) if (typeof v === 'string') secByTitle[k] = v;
	const strings = (v: unknown): string[] => list(v).filter((x): x is string => typeof x === 'string');
	return {
		app: 'Throughline', v: 1, saved: str(raw['saved'], 40),
		settings: { ...EMPTY_DOC_SETTINGS, title: str(s['title'], 300), thread: str(s['thread'], 2000), style: str(s['style'], 6000), language: str(s['language'], 60), textLang: isLanguageTag(str(s['textLang'], 35)) ? str(s['textLang'], 35) : '' },
		cache, secByTitle, lastDoc: typeof raw['lastDoc'] === 'string' ? raw['lastDoc'] : null,
		ignored: strings(raw['ignored']), dismissed: strings(raw['dismissed']),
	};
}
