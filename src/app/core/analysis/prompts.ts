/**
 * Prompts and JSON schemas. Reading keys include `PROMPT_VERSION`:
 * change it whenever a prompt changes, or old readings will be reused for new questions.
 */
import type { DocSettings } from '../model';
import { ISSUE_TYPES } from './readings';

export const PROMPT_VERSION = 'v1';

export interface ChatMessage { readonly role: 'system' | 'user' | 'assistant'; readonly content: string }
export interface OutlineLine { readonly level: number; readonly title: string; readonly summary: string | null; readonly keywords: readonly string[] }

const SYSTEM_EDITOR = "You are a careful editor of long-form writing. You point at specific problems so the author can fix them; you never rewrite the author's text. Reply with a single JSON object and nothing else.";

const languageLine = (s: DocSettings): string =>
	s.language ? `Write gist, notes and all other prose in ${s.language}.` : 'Write gist, notes and all other prose in the same language as the text.';

export const SCHEMAS = {
	para: { type: 'object', properties: { gist: { type: 'string' }, flow: { type: 'string' }, clarity: { type: 'integer' }, issues: { type: 'array', maxItems: 8, items: { type: 'object', properties: { type: { type: 'string', enum: [...ISSUE_TYPES] }, quote: { type: 'string' }, suggestion: { type: 'string' }, note: { type: 'string' } }, required: ['type', 'quote', 'note'] } } }, required: ['gist', 'flow', 'clarity', 'issues'] },
	section: { type: 'object', properties: { keywords: { type: 'array', maxItems: 6, items: { type: 'string' } }, summary: { type: 'string' }, line: { type: 'string' }, cohesion: { type: 'integer' }, paragraphs: { type: 'array', items: { type: 'object', properties: { n: { type: 'integer' }, fit: { type: 'integer' }, bridge: { type: 'integer' }, note: { type: 'string' } }, required: ['n', 'fit', 'bridge'] } }, breaks: { type: 'array', maxItems: 6, items: { type: 'object', properties: { n: { type: 'integer' }, note: { type: 'string' } }, required: ['n', 'note'] } }, suggestions: { type: 'array', maxItems: 3, items: { type: 'string' } } }, required: ['keywords', 'summary', 'line', 'cohesion', 'paragraphs', 'breaks', 'suggestions'] },
	doc: { type: 'object', properties: { thread: { type: 'string' }, cohesion: { type: 'integer' }, feedback: { type: 'array', maxItems: 8, items: { type: 'object', properties: { kind: { type: 'string', enum: ['structure', 'idea', 'source', 'question'] }, text: { type: 'string' }, section: { type: ['integer', 'null'] } }, required: ['kind', 'text'] } } }, required: ['thread', 'cohesion', 'feedback'] },
} as const;

export function paragraphPrompt(text: string, s: DocSettings): ChatMessage[] {
	return [{ role: 'system', content: SYSTEM_EDITOR }, { role: 'user', content:
`STYLE GUIDE FOR THE WHOLE DOCUMENT:
${s.style || 'None given. Judge by the standards of clear, well-edited prose.'}

PARAGRAPH:
<<<
${text}
>>>

Return JSON: {"gist": string, "flow": string, "clarity": 1-5, "issues": [{"type": "cut"|"change"|"ambiguous"|"repetition"|"style", "quote": string, "suggestion": string, "note": string}]}

- gist: what the paragraph claims or does, at most 10 words.
- flow: one sentence on rhythm, the transitions between its sentences, and readability.
- clarity: 1 = hard to follow, 5 = very clear.
- issues: at most 8, most important first. "quote" must be copied character for character from the paragraph and be as short as possible: a word or a phrase, a whole sentence only if necessary.
  cut = words that can go without loss (suggestion empty). change = a better word or phrase (suggestion replaces the quote exactly). ambiguous = unclear reference, vague term, or a sentence with two readings. repetition = a word or idea repeated too closely. style = breaks the style guide.
- Return few or no issues if the paragraph is good. Do not judge facts you cannot check.
- ${languageLine(s)}` }];
}

export function sectionPrompt(input: { readonly pathText: string; readonly paragraphs: readonly string[]; readonly settings: DocSettings; readonly budget: number }): ChatMessage[] {
	const { pathText, paragraphs, settings: s } = input;
	const per = Math.max(280, Math.floor(input.budget / Math.max(1, paragraphs.length)));
	const listing = paragraphs.map((t, i) => `[${i + 1}] ${t.length > per ? `${t.slice(0, per - 40)} […] ${t.slice(-30)}` : t}`).join('\n\n');
	return [{ role: 'system', content: SYSTEM_EDITOR }, { role: 'user', content:
`DOCUMENT THROUGHLINE (the author's main line of thought): ${s.thread || '(not stated)'}
SECTION: ${pathText}

PARAGRAPHS:
${listing}

Return JSON: {"keywords": [string], "summary": string, "line": string, "cohesion": 0-100, "paragraphs": [{"n": number, "fit": 1-5, "bridge": 1-5, "note": string}], "breaks": [{"n": number, "note": string}], "suggestions": [string]}

- keywords: 3 to 6 short terms that let the author recognise this section at a glance.
- summary: what the section covers, one sentence.
- line: the section's argument or line of thought as it reads now, one sentence.
- cohesion: how well the paragraphs form one connected line (100 = every paragraph builds on the one before and serves the section's topic).
- paragraphs: one entry per paragraph. fit = how well it serves the section's topic and line. bridge = how well it follows from the paragraph before it (for [1]: how well it opens the section). note: a few words, only when fit or bridge is 3 or lower.
- breaks: paragraphs where the line of thought jumps, drifts or repeats; n is the paragraph number.
- suggestions: at most 3 concrete ways to tighten the section (order, a missing step, a needed transition, a counterargument).
- ${languageLine(s)}` }];
}

const outlineText = (outline: readonly OutlineLine[]): string =>
	outline.map((x, i) => `${i + 1}. ${'  '.repeat(Math.max(0, x.level - 1))}${x.title}${x.summary ? ` | ${x.summary} | keywords: ${x.keywords.join(', ')}` : ''}`).join('\n');

export function documentPrompt(input: { readonly outline: readonly OutlineLine[]; readonly settings: DocSettings }): ChatMessage[] {
	const s = input.settings;
	return [{ role: 'system', content: SYSTEM_EDITOR }, { role: 'user', content:
`STATED THROUGHLINE: ${s.thread || '(not stated)'}
STYLE GUIDE: ${s.style || '(none)'}

OUTLINE WITH SECTION SUMMARIES:
${outlineText(input.outline)}

Return JSON: {"thread": string, "cohesion": 0-100, "feedback": [{"kind": "structure"|"idea"|"source"|"question", "text": string, "section": number|null}]}

- thread: the document's main line of thought as it reads now, one sentence.
- cohesion: how well the sections follow one line from start to end.
- feedback: 3 to 8 items. structure = a section that drifts from the throughline, sits in the wrong place or repeats another. idea = an argument, example or angle worth adding. source = an author, book or study worth consulting; name author and year, and only name works you are sure exist. question = an objection a critical reader would raise. "section" is the outline number the item refers to, or null.
- ${languageLine(s)}` }];
}

export interface ChatTurn { readonly role: 'user' | 'assistant'; readonly text: string }

export function chatPrompt(input: {
	readonly settings: DocSettings; readonly outline: readonly OutlineLine[];
	readonly section: { readonly pathText: string; readonly paragraphs: readonly string[] } | null;
	readonly current: string; readonly history: readonly ChatTurn[]; readonly question: string; readonly budget: number;
}): ChatMessage[] {
	const s = input.settings;
	let sectionText = input.section ? input.section.paragraphs.map((p, k) => `[${k + 1}] ${p}`).join('\n\n') : '';
	if (sectionText.length > input.budget) sectionText = `${sectionText.slice(0, input.budget)} […]`;
	const outline = input.outline.map(x => `${'  '.repeat(Math.max(0, x.level - 1))}- ${x.title}${x.summary ? `: ${x.summary}` : ''}`).join('\n');
	const system = `You are an editor and research partner helping an author with a long text. Help them think: answer questions, point out problems, suggest structure, arguments and sources. Do not write passages for the author unless they ask. Be concise. Only name sources you are confident exist.
${s.title ? `\nTITLE: ${s.title}` : ''}
THROUGHLINE: ${s.thread || '(not stated)'}
STYLE GUIDE: ${s.style || '(none)'}

OUTLINE:
${outline || '(no headings yet)'}

CURRENT SECTION: ${input.section ? input.section.pathText : '(none)'}
${sectionText}

PARAGRAPH UNDER THE CURSOR:
${input.current}`;
	return [{ role: 'system', content: system }, ...input.history.slice(-8).map(m => ({ role: m.role, content: m.text })), { role: 'user', content: input.question }];
}
