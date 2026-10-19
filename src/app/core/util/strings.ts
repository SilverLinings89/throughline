/** Escapes text for HTML. */
export function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, c => HTML_ENTITIES[c] ?? c);
}
const HTML_ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escapes text for XML and drops characters XML 1.0 forbids. */
export function escapeXml(s: string): string {
	return s
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
		.replace(/[&<>"]/g, c => HTML_ENTITIES[c] ?? c);
}

export function clamp(n: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, n));
}

/** Short random id for blocks. Not a security token. */
export function newId(): string {
	return Math.random().toString(36).slice(2, 8) + (Date.now() % 1e6).toString(36);
}

/** The first `n` words of a text, with an ellipsis when cut. */
export function firstWords(text: string, n: number): string {
	const words = text.trim().split(/\s+/);
	return words.slice(0, n).join(' ') + (words.length > n ? '…' : '');
}
