/**
 * When a section or the whole text is worth reading again. Section and document readings are the
 * expensive requests, so small edits keep the earlier reading (shown as "from an earlier version")
 * and only substantial changes ask the model again.
 */

/** What a section looked like when it was sent to the model. */
export interface SectionBasis {
	/** Paragraph hashes and texts, in order. */
	readonly paras: readonly { readonly hash: string; readonly text: string }[];
	/** Main line, style guide and language at the time. */
	readonly sig: string;
}

/** Share of a section's text that must change before it is read again. */
export const SECTION_CHANGE_SHARE = 0.25;
/** Paragraphs added or removed before a section is read again, whatever their length. */
export const SECTION_CHANGE_PARAS = 2;

export function sectionBasis(paras: readonly { readonly hash: string; readonly text: string }[], sig: string): SectionBasis {
	return { paras: paras.map(p => ({ hash: p.hash, text: p.text })), sig };
}

/** Characters that differ between two versions of a paragraph, ignoring a shared start and end. */
export function editSize(a: string, b: string): number {
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) start++;
	let end = 0;
	while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
	return Math.max(a.length, b.length) - start - end;
}

/**
 * True when `now` differs enough from `then` to read the section again: the settings changed,
 * a quarter of its text changed, or two or more paragraphs came or went. With no basis (the
 * reading came from a file, or from before a reload) the section counts as changed.
 */
export function sectionChanged(then: SectionBasis | undefined, now: SectionBasis): boolean {
	if (!then || then.sig !== now.sig) return true;
	if (Math.abs(now.paras.length - then.paras.length) >= SECTION_CHANGE_PARAS) return true;
	const before = new Set(then.paras.map(p => p.hash));
	const after = new Set(now.paras.map(p => p.hash));
	const gone = then.paras.filter(p => !after.has(p.hash));
	const fresh = now.paras.filter(p => !before.has(p.hash));
	// Pair edited paragraphs in order and count only what changed inside them.
	let changed = 0;
	for (let i = 0; i < Math.max(gone.length, fresh.length); i++) changed += editSize(gone[i]?.text ?? '', fresh[i]?.text ?? '');
	const total = Math.max(1, ...[then, now].map(b => b.paras.reduce((n, p) => n + p.text.length, 0)));
	return changed / total >= SECTION_CHANGE_SHARE;
}

/** What the outline looked like when the whole text was last sent to the model. */
export interface DocBasis {
	readonly sig: string;
	/** Section titles in order. */
	readonly titles: string;
	/** Section readings received since. */
	freshSections: number;
}

/** Minimum time between two readings of the whole text, unless the settings or headings changed. */
export const DOC_MIN_INTERVAL = 10 * 60e3;

/**
 * True when the whole text should be read again: never read, the main line, style, language or
 * title changed, headings were added, removed or renamed, or a third of the sections got new
 * readings and the last whole-text reading is older than `DOC_MIN_INTERVAL`.
 */
export function docChanged(then: DocBasis | undefined, sig: string, titles: string, sections: number, sinceMs: number): boolean {
	if (!then || then.sig !== sig || then.titles !== titles) return true;
	return then.freshSections >= Math.max(2, Math.ceil(sections / 3)) && sinceMs >= DOC_MIN_INTERVAL;
}
