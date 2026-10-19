/** Small helpers over the browser's XML DOM. */

export function parseXml(source: string): XMLDocument {
	const doc = new DOMParser().parseFromString(source, 'application/xml');
	if (doc.getElementsByTagName('parsererror').length) throw new Error('The file contains XML that cannot be read.');
	return doc;
}

export function serializeXml(node: Node): string {
	return new XMLSerializer().serializeToString(node);
}

/** Child elements, optionally filtered by local name. */
export function childElements(el: Element | null, localName?: string): Element[] {
	if (!el) return [];
	return Array.from(el.children).filter(c => !localName || c.localName === localName);
}

/** First child element with the local name, or null. */
export function childElement(el: Element | null, localName: string): Element | null {
	if (!el) return null;
	for (const c of Array.from(el.children)) if (c.localName === localName) return c;
	return null;
}

/** Adds `xmlns:prefix="uri"` to the root start tag of a serialized document when it is missing. */
export function ensureRootNamespace(xml: string, prefix: string, uri: string): string {
	const start = xml.search(/<(?![?!])/);
	const end = xml.indexOf('>', start);
	const tag = xml.slice(start, end);
	if (new RegExp(`\\sxmlns:${prefix}=`).test(tag)) return xml;
	const at = tag.endsWith('/') ? end - 1 : end;
	return `${xml.slice(0, at)} xmlns:${prefix}="${uri}"${xml.slice(at)}`;
}

/** Resolves a package-relative target such as `../customXml/item1.xml` against a directory. */
export function resolvePath(baseDir: string, target: string): string {
	if (target.startsWith('/')) return target.slice(1);
	const out: string[] = [];
	for (const p of (baseDir + target).split('/')) {
		if (p === '..') out.pop();
		else if (p && p !== '.') out.push(p);
	}
	return out.join('/');
}

/** JSON that can sit inside XML text without escaping: `<`, `>` and `&` become \u escapes. */
export function jsonForXml(value: unknown): string {
	return JSON.stringify(value).replace(/[<>&]/g, c => `\\u00${c.charCodeAt(0).toString(16)}`);
}

/**
 * Replaces the content of an element in a serialized document, keeping its start tag.
 * Uses the first start tag and the last end tag, which suits unique containers such as `<w:body>`.
 */
export function replaceElementContent(xml: string, qualifiedName: string, content: string): string {
	const open = new RegExp(`<${qualifiedName}(\\s[^>]*)?(\\/?)>`).exec(xml);
	if (!open) throw new Error(`<${qualifiedName}> was not found.`);
	if (open[2] === '/') {
		return `${xml.slice(0, open.index)}<${qualifiedName}${open[1] ?? ''}>${content}</${qualifiedName}>${xml.slice(open.index + open[0].length)}`;
	}
	const close = xml.lastIndexOf(`</${qualifiedName}>`);
	return xml.slice(0, open.index + open[0].length) + content + xml.slice(close);
}
