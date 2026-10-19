/** Guesses the language of a text from its most common short words. No model, no network. */

/** Languages the editor offers by name. `code` is a BCP 47 tag, as used by `lang` and `Intl`. */
export const TEXT_LANGUAGES: readonly { readonly code: string; readonly name: string }[] = [
	{ code: 'de-DE', name: 'Deutsch (Deutschland)' }, { code: 'de-AT', name: 'Deutsch (Österreich)' }, { code: 'de-CH', name: 'Deutsch (Schweiz)' },
	{ code: 'en-US', name: 'English (US)' }, { code: 'en-GB', name: 'English (UK)' },
	{ code: 'fr-FR', name: 'Français' }, { code: 'es-ES', name: 'Español' }, { code: 'it-IT', name: 'Italiano' }, { code: 'nl-NL', name: 'Nederlands' },
];

const MARKERS: Record<string, readonly string[]> = {
	de: ['der', 'die', 'das', 'und', 'ist', 'nicht', 'ein', 'eine', 'zu', 'den', 'mit', 'sich', 'auf', 'für', 'auch', 'dass', 'wird', 'von', 'im', 'werden'],
	en: ['the', 'and', 'is', 'of', 'to', 'in', 'that', 'it', 'for', 'with', 'as', 'was', 'on', 'are', 'this', 'be', 'by', 'not', 'which', 'have'],
	fr: ['le', 'la', 'les', 'et', 'est', 'des', 'une', 'du', 'que', 'dans', 'pour', 'qui', 'pas', 'sur', 'au', 'avec', 'ce', 'il', 'sont', 'mais'],
	es: ['el', 'la', 'los', 'las', 'y', 'es', 'del', 'que', 'en', 'un', 'una', 'por', 'con', 'para', 'se', 'no', 'su', 'al', 'como', 'más'],
	it: ['il', 'la', 'di', 'che', 'e', 'è', 'un', 'una', 'per', 'non', 'con', 'del', 'della', 'sono', 'gli', 'le', 'si', 'nel', 'anche', 'come'],
	nl: ['de', 'het', 'een', 'en', 'van', 'is', 'dat', 'niet', 'op', 'te', 'met', 'voor', 'zijn', 'ook', 'aan', 'om', 'maar', 'die', 'er', 'wordt'],
};
const DEFAULT_TAG: Record<string, string> = { de: 'de-DE', en: 'en', fr: 'fr-FR', es: 'es-ES', it: 'it-IT', nl: 'nl-NL' };

/**
 * The likely language of `text` as a BCP 47 tag, or null when there are too few words to tell.
 * Only the first `limit` characters are looked at.
 */
export function detectLanguage(text: string, limit = 4000): string | null {
	const words = text.slice(0, limit).toLowerCase().match(/\p{L}+/gu) ?? [];
	if (words.length < 12) return null;
	const counts = new Map<string, number>();
	for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);
	let best: string | null = null;
	let bestScore = 0;
	let second = 0;
	for (const [lang, markers] of Object.entries(MARKERS)) {
		let score = 0;
		for (const m of markers) score += counts.get(m) ?? 0;
		if (score > bestScore) { second = bestScore; bestScore = score; best = lang; } else if (score > second) second = score;
	}
	// Ask for a clear lead and a few hits per hundred words, or say nothing.
	if (!best || bestScore < Math.max(3, words.length * 0.04) || bestScore < second * 1.3) return null;
	return DEFAULT_TAG[best] ?? best;
}

/** True for a plausible BCP 47 tag such as `de`, `de-DE` or `zh-Hant-TW`. */
export function isLanguageTag(s: string): boolean {
	return /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(s);
}

/** A display name for a tag, in the language itself where the browser knows it. */
export function languageName(tag: string): string {
	const listed = TEXT_LANGUAGES.find(l => l.code === tag);
	if (listed) return listed.name;
	try { return new Intl.DisplayNames([tag], { type: 'language' }).of(tag) ?? tag; } catch { return tag; }
}
