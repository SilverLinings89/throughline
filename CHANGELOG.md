# Changelog

## Unreleased

- The lens lists Clarity, Serves the section and Follows from ¶ on separate lines again. Its styles never applied because the panel lacked the `lens` class.
- New **Usage** tab in the settings: time, queue wait, tokens and unusable answers per request, summarised by model and kind, with a hint whether a smaller or larger model fits. Records stay in the browser and can be copied as CSV.
- New document setting **Language of the text**. It sets the editor's `lang`, so spell checking and sentence splitting use the right language. When unset, the language is detected from the text. Spell checking can be switched off in the Editor tab.
- Focus mode (`Ctrl+Shift+F` or the button in the top bar) folds away both side panels and fades the top bar.
- The top bar shows how many paragraphs changed since the last save and for how long; the reminder turns orange after 15 minutes or 10 changes. Click it to save.
- Margin markers are easier to read: unread, read and edited-since-read paragraphs look different, the suggestion count is a badge with a tooltip, and the Editor tab has a legend.
- On wide windows the thread in the margin sits further from the text.
- Answers that LM Studio files as reasoning (schema-constrained output from Qwen 3 and other thinking models) are read instead of counted as unusable.
- Far fewer model requests. Only the paragraph the cursor rests in is read; sections and the whole text are read on opening and after substantial changes. At most three requests wait or run. Running requests are no longer cancelled by edits or interrupted by urgent ones, and a timeout or unusable answer is not retried for the same text. Answers have a default length limit.

## 2.0.0

Rewrite as an installable Angular 22 app.

- The app installs as a PWA, works offline, and opens `.docx`, `.odt`, `.md` and `.txt` files passed in by the operating system.
- All logic that does not need Angular moved to `src/app/core` and has unit tests.
- Files saved by 1.0.0 open with their readings. The reading keys and the embedded data format are unchanged.
- The connection check runs on the page's own thread, so Chrome can ask for local network access when the app is hosted.
- Footnote markers from a `.docx` are no longer written into an `.odt` on **Save as**, and the reverse.
- A model job without a JSON schema no longer records JSON-schema support for the server.

## 1.0.0

Single HTML file with the same editor, map, desk, lens and background readings.
