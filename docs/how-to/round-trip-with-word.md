# How to work with Word and LibreOffice files

## Open and save

- To open a file, press `Ctrl+O` or drop the file on the window.
- To save into the same file, press `Ctrl+S`. Chrome and Edge write back into the file you opened. Firefox and Safari save a copy to your downloads.
- To save in another format, click the **…** button at the top of the map and pick a format.

## Know what is kept

Throughline edits paragraphs, headings, lists, bold, italics and links. Everything else is kept.

- A paragraph you did not change is written back exactly as it was read, including Word styles, comments and section breaks.
- Tables, images, formulas and tables of contents appear as grey placeholders. They are written back unchanged. You can delete a placeholder, but not edit it.
- Footnote markers appear as small red numbers. Keep them in place and the footnote survives.
- A paragraph you changed keeps its paragraph style, bold, italics and links. Font changes applied to single words in that paragraph are lost.
- Nested lists come back as one level.

Placeholders and footnotes stay only in the format they came from. If you save a `.docx` as `.odt`, tables and images are left out, and a message says how many.

## Let others edit the file in between

You can open the same file in Word while Throughline has it open.

1. Save in Word.
2. Switch back to Throughline. A banner says the file was changed in another program.
3. Click **Reload the file**.

Readings of unchanged paragraphs are kept, because readings are stored by the text they belong to. Only the edited paragraphs and their sections are read again. This also works when Word saved the file on another computer.

## Keep readings out of a file

By default, a saved file contains the readings and your document settings: title, main line of thought, style guide and language. In a `.docx`, they sit in a custom XML part that Word keeps when it saves. In an `.odt`, they sit in `Throughline/analysis.json` inside the package.

To leave them out, open **Settings**, then **This document**, and clear **Keep these settings and the model's readings inside the file**. The readings stay in your browser, and the document settings are stored in the browser under the file name.

## Open a file from the single-file editor

Files saved by Throughline 1.0.0, the single HTML file, open with their readings. Nothing needs converting.
