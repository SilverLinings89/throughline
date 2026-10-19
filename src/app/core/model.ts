/**
 * Shared data model. Everything here is plain data: no DOM nodes, no Angular.
 * Readers produce `Block`s, the editor renders them, writers consume `SaveBlock`s.
 */

/** Block kinds the editor understands. `opaque` is content kept untouched (tables, images). */
export type BlockType = 'p' | 'h1' | 'h2' | 'h3' | 'ul' | 'ol' | 'opaque';
export type TextBlockType = Exclude<BlockType, 'opaque'>;
export type HeadingType = 'h1' | 'h2' | 'h3';
export type ListType = 'ul' | 'ol';

/** File formats the app reads and writes. */
export type DocFormat = 'docx' | 'odt' | 'md' | 'txt';
/** Zip-based office formats that can carry kept content and embedded analysis. */
export type PackageFormat = 'docx' | 'odt';

/** Formatted text. `href` is null outside links. */
export interface TextRun {
	readonly kind: 'text';
	t: string;
	b: boolean;
	i: boolean;
	href: string | null;
}
/** Inline content the editor cannot edit but must keep, such as a footnote reference. */
export interface TokenRun {
	readonly kind: 'token';
	/** Format the `xml` belongs to. A token is written back only into the same format. */
	readonly fmt: PackageFormat;
	readonly xml: string;
	readonly label: string;
}
export type Run = TextRun | TokenRun;

/** What a .docx paragraph looked like when it was read. Used to write it back unchanged. */
export interface DocxMeta {
	readonly fmt: 'docx';
	readonly type: BlockType;
	readonly xml: string;
	readonly pPrXml: string;
	readonly numId: string | null;
	/** Hidden body-level markup (bookmarks, comment ranges) that preceded the paragraph. */
	readonly pre: string;
}
/** What an .odt paragraph looked like when it was read. */
export interface OdtMeta {
	readonly fmt: 'odt';
	readonly type: BlockType;
	readonly xml: string;
	readonly styleName: string;
	readonly listStyle: string;
}
export type BlockMeta = DocxMeta | OdtMeta;

export type Block =
	| { readonly type: TextBlockType; readonly runs: Run[]; readonly meta: BlockMeta | null }
	| { readonly type: 'opaque'; readonly label: string; readonly meta: BlockMeta };

/** A block on its way to a writer. `unchanged` means: emit `meta.xml` byte for byte. */
export type SaveBlock = Block & { readonly unchanged: boolean };

/** Per-document settings, stored inside the file. */
export interface DocSettings {
	title: string;
	/** The author's main line of thought. */
	thread: string;
	/** Style guide every paragraph is checked against. */
	style: string;
	/** Language for feedback. Empty means: the language of the text. */
	language: string;
	/** BCP 47 tag of the text itself, for spell checking and sentence splitting. Empty means: detect it. */
	textLang: string;
}
export const EMPTY_DOC_SETTINGS: DocSettings = Object.freeze({ title: '', thread: '', style: '', language: '', textLang: '' });

export type Bytes = Uint8Array<ArrayBuffer>;
