# File formats and embedded data

## Supported formats

| Format | Extensions | Read | Written | Kept items | Embedded data |
| --- | --- | --- | --- | --- | --- |
| Word | `.docx`, `.docm`, `.dotx` | Yes | Yes | Tables, images, formulas, content controls, footnote and endnote references, bookmarks and comment ranges between paragraphs | Custom XML part |
| OpenDocument | `.odt`, `.ott` | Yes | Yes | Tables, images, tables of contents, notes | `Throughline/analysis.json` |
| Markdown | `.md`, `.markdown` | Yes | Yes | None | None |
| Plain text | `.txt` | Yes | Yes | None | None |

Old binary `.doc` files and Strict Open XML `.docx` files are refused with a message.

## Blocks

Every format is read into a list of blocks. A block has one of these types.

| Type | .docx source | .odt source | Markdown source |
| --- | --- | --- | --- |
| `h1`, `h2`, `h3` | Paragraph with outline level 1 to 3, a style named `heading 1` to `heading 3`, or `Title` | `text:h`, or `text:p` with a `Heading_20_N` style or an outline level | `#`, `##`, `###` and deeper |
| `p` | Paragraph | `text:p` | Paragraph |
| `ul`, `ol` | Paragraph with numbering. The numbering format decides the type. | `text:list` item. The list style decides the type. | `-`, `*`, `+` or `1.` |
| `opaque` | Table, content control, or a paragraph with a drawing, picture, object or formula | Table, table of contents, or a paragraph with a drawing | Never |

Inline content becomes runs: text with bold, italic and a link target, or a token. A token holds markup the editor keeps but cannot edit, such as a footnote reference. A token is written back only into the format it came from.

## How unchanged paragraphs are detected

When a document opens, each block's type and runs are turned into a signature. On save, a block whose signature is unchanged is written from its original XML. A changed block is rebuilt from its runs and keeps its original paragraph properties.

## Embedded data

The data is one JSON object. In a `.docx`, it is the text content of the root element of a custom XML part:

```xml
<tl:throughline xmlns:tl="urn:throughline:analysis" version="1">{ … }</tl:throughline>
```

The part is `customXml/itemN.xml`, with `customXml/itemPropsN.xml` and a relationship of type `…/relationships/customXml` from the main document part. The characters `<`, `>` and `&` in the JSON are written as `\u003c`, `\u003e` and `\u0026`.

In an `.odt`, the same JSON is the file `Throughline/analysis.json`, listed in `META-INF/manifest.xml` with the media type `application/json`.

| Field | Type | Content |
| --- | --- | --- |
| `app` | `"Throughline"` | Identifies the data. Other values are ignored. |
| `v` | `1` | Format version. |
| `saved` | string | ISO 8601 time of saving. |
| `settings` | object | `title`, `thread`, `style` and `language`, as in [Settings](settings.md). |
| `cache` | object | Readings by reading key. |
| `secByTitle` | object | Section title hash to the key of the section's last reading. |
| `lastDoc` | string or null | Key of the last whole-document reading. |
| `ignored` | string array | Ids of suggestions the author ignored. |
| `dismissed` | string array | Hashes of notes the author hid. |

Every field is checked when a file opens. A reading that does not match its shape is dropped.

## Reading keys

Keys use `hash`, a 53-bit hash in base 36 (cyrb53), defined in `src/app/core/util/hash.ts`. `PROMPT_VERSION` is `v1`.

| Reading | Key |
| --- | --- |
| Paragraph | `p:` + hash(trimmed text) + `:` + hash(`PROMPT_VERSION` + `\|` + style guide + `\|` + language) |
| Section | `s:` + hash(title + newline + comma-separated paragraph hashes + newline + hash(main line) + `\|` + `PROMPT_VERSION`) |
| Document | `d:` + hash(comma-separated section keys + `\|` + hash(main line) + `\|` + style hash) |

A section key covers only the section's own paragraphs, not its subsections. Paragraphs shorter than 25 characters get no paragraph reading, but count in their section.

## Readings

| Kind | Fields |
| --- | --- |
| `para` | `gist`, `flow`, `clarity` (1 to 5 or null), `issues`: `type` (`cut`, `change`, `ambiguous`, `repetition` or `style`), `quote`, `suggestion`, `note` |
| `section` | `keywords`, `summary`, `line`, `cohesion` (0 to 100 or null), `paragraphs`: `n`, `fit` and `bridge` (1 to 5 or null), `note`; `breaks`: `n`, `note`; `suggestions` |
| `doc` | `thread`, `cohesion`, `feedback`: `kind` (`structure`, `idea`, `source` or `question`), `text`, `section` (1-based position in the outline, or null) |

Files from version 1.0.0 store readings without the `kind` field. The kind is then taken from the key's prefix.
