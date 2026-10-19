/** Language-light text analysis that runs instantly, without a model. */

export interface Sentence { readonly start: number; readonly end: number; readonly text: string }
export interface SentenceStats extends Sentence { readonly words: number }
export interface Span { readonly start: number; readonly end: number }
export interface LocalChecks {
	/** Content words of five or more letters repeated within 25 words. */
	readonly repeats: { readonly word: string; readonly spans: Span[] }[];
	readonly doubled: (Span & { readonly word: string })[];
	readonly sentences: SentenceStats[];
	/** Sentences longer than `LONG_SENTENCE` words. */
	readonly long: SentenceStats[];
}
export const LONG_SENTENCE = 35;

/** Splits text into sentences with `Intl.Segmenter`, falling back to punctuation. */
export function sentencesOf(text: string, language?: string): Sentence[] {
	const out: Sentence[] = [];
	if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
		try {
			const seg = new Intl.Segmenter(language || undefined, { granularity: 'sentence' });
			for (const s of seg.segment(text)) if (s.segment.trim()) out.push({ start: s.index, end: s.index + s.segment.length, text: s.segment });
			return out;
		} catch { /* unknown locale: fall through */ }
	}
	const re = /[^.!?…]+(?:[.!?…]+["'»”’)\]]*|$)\s*/g;
	for (let m = re.exec(text); m && m[0]; m = re.exec(text)) if (m[0].trim()) out.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
	return out;
}

/** English and German function words of five or more letters, ignored by the repeat check. */
const STOP = new Set(('about above after again against among because before being below between could doing during every further having their there these those through under until where which while would should other might shall still since theirs itself themselves yourself whose whom what when also into than then them they this that with from have were been your more most much such some only very just over each both same ' +
	'nicht diese dieser dieses einer eines einem einen werden wurde wurden haben hatte hatten durch unter zwischen sondern sowie denen deren können könnte müssen sollte wieder immer schon nach aber auch noch oder sind sein seine seiner ihrer ihren ihre ihnen wenn dann damit dabei dafür darauf daran davon worden würde welche welcher welches selbst etwas allem allen alles anderen andere anderer mehr sehr ganz gegen ohne über unsere unser ebenso jedoch bereits zwar weil dass also hier dort').split(' '));

/** Repeats, doubled words and sentence lengths. `keywords` are exempt from the repeat check. */
export function localChecks(text: string, keywords: readonly string[] = [], language?: string): LocalChecks {
	const words: { w: string; start: number; end: number }[] = [];
	const re = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;
	for (let m = re.exec(text); m; m = re.exec(text)) words.push({ w: m[0].toLowerCase(), start: m.index, end: m.index + m[0].length });
	const exempt = new Set(keywords.map(k => k.toLowerCase()));
	const repeats = new Map<string, Set<(typeof words)[number]>>();
	for (let i = 0; i < words.length; i++) {
		const a = words[i];
		if (a.w.length < 5 || STOP.has(a.w) || exempt.has(a.w)) continue;
		for (let j = i + 1; j < Math.min(words.length, i + 26); j++) {
			if (words[j].w !== a.w) continue;
			const set = repeats.get(a.w) ?? new Set();
			set.add(a); set.add(words[j]);
			repeats.set(a.w, set);
			break;
		}
	}
	const doubled: (Span & { word: string })[] = [];
	for (let i = 1; i < words.length; i++) {
		if (words[i].w === words[i - 1].w && /^\s+$/.test(text.slice(words[i - 1].end, words[i].start))) doubled.push({ word: words[i].w, start: words[i].start, end: words[i].end });
	}
	const sentences = sentencesOf(text, language).map(s => ({ ...s, words: (s.text.match(/[\p{L}\p{N}]+/gu) ?? []).length }));
	return {
		repeats: [...repeats].map(([word, set]) => ({ word, spans: [...set].map(({ start, end }) => ({ start, end })) })),
		doubled, sentences, long: sentences.filter(s => s.words > LONG_SENTENCE),
	};
}

/**
 * Finds a quote from a model inside the text. Tolerates curly versus straight quotes,
 * dash variants, whitespace and case, because local models rarely copy exactly.
 * Returns the start offset in `text`, or -1.
 */
export function findQuote(text: string, quote: string): number {
	if (!quote) return -1;
	const direct = text.indexOf(quote);
	if (direct >= 0) return direct;
	const norm = (s: string): string => s.replace(/[“”„«»"]/g, '"').replace(/[‘’‚‹›']/g, "'").replace(/[–—]/g, '-').replace(/\s+/g, ' ');
	const map: number[] = [];
	let normalized = '';
	for (let k = 0; k < text.length; k++) {
		const c = norm(text[k]);
		if (c === ' ' && normalized.endsWith(' ')) continue;
		normalized += c;
		map.push(k);
	}
	const q = norm(quote).trim();
	let i = normalized.indexOf(q);
	if (i < 0) i = normalized.toLowerCase().indexOf(q.toLowerCase());
	return i < 0 ? -1 : map[i];
}

/** Length in `text` of a quote found at `start` by `findQuote`. */
export function quoteLength(text: string, start: number, quote: string): number {
	if (text.startsWith(quote, start)) return quote.length;
	const target = quote.replace(/\s+/g, ' ').trim().length;
	let n = 0;
	let k = start;
	while (k < text.length && n < target) {
		if (!(/\s/.test(text[k]) && /\s/.test(text[k - 1] ?? ''))) n++;
		k++;
	}
	return k - start;
}
