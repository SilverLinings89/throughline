# Settings

Settings come in three groups, plus a **Usage** tab that only shows measurements. **This document** is saved with the document. **Model** and **Editor** are saved in the browser under the `localStorage` key `throughline.settings` and apply to every document.

## This document

| Setting | Field | Default | Effect |
| --- | --- | --- | --- |
| Title | `title` | Empty | Shown in the map and the window title. When empty, the first Heading 1 is shown, then the file name. |
| Main line of thought | `thread` | Empty | Section and document readings measure the text against it. Changing it invalidates section and document readings. |
| Style guide | `style` | Empty | Every paragraph is checked against it. Changing it invalidates paragraph readings. |
| Language of the text | `textLang` | Empty | BCP 47 tag such as `de-DE`. Set as the editor's `lang`, so the browser checks spelling in this language when its dictionary is installed, and used for sentence splitting. When empty, the language is guessed from the start of the text. |
| Language of the feedback | `language` | Empty | Language of gists, notes and suggestions. When empty, the model answers in the text's language. Changing it invalidates paragraph readings. |
| Keep settings and readings inside the file | `editor.embed` | On | Writes the readings and these settings into saved files. Stored in the browser, not in the document. |

## Model

| Setting | Field | Default | Effect |
| --- | --- | --- | --- |
| Read the text in the background | `ai.enabled` | On | When off, no requests are sent. The chat still needs a model. |
| Server address | `ai.baseUrl` | `http://localhost:11434/v1` | Base URL of an OpenAI-compatible API. `/chat/completions` and `/models` are appended. |
| Model | `ai.model` | Empty | Model name as the server knows it. No requests are sent while it is empty. |
| API key | `ai.apiKey` | Empty | Sent as `Authorization: Bearer <key>`. |
| Temperature | `ai.temperature` | `0.2` | Sampling temperature for readings. The chat uses `0.4`. |
| Requests at once | `ai.concurrency` | `1` | How many requests run in parallel. Raise it only if the server runs several models or slots. |
| Time limit | `ai.timeoutSec` | `240` | Seconds before a request is cancelled and counted as failed. |
| Structured answers | `ai.structured` | `auto` | `json_schema`, `json_object` or `none`. `auto` tries them in that order and keeps the first that the server accepts. |
| Text per section request | `ai.budget` | `12000` | Characters of section text per request. Long paragraphs are shortened to fit. |
| Wait before reading the paragraph you are in | `ai.paraDelaySec` | `4` | Seconds without typing before the current paragraph is read. 1.5 seconds while the lens is open. The cursor must also rest in the paragraph for 2 seconds. Only this paragraph is read; others are read when you go to them. |
| Answer length limit | `ai.maxTokens` | `0` | `max_tokens` for each request. `0` is automatic: 1,500 tokens for a paragraph, 2,500 for a section or the whole text, no limit for questions. |
| Start no new requests while you type | `ai.pauseWhileTyping` | On | Holds new requests for 2.2 seconds after each keystroke. Running requests continue. |

**Forget all stored readings** clears the reading cache in the browser. Readings inside files stay until those files are saved again.

## Editor

| Setting | Field | Default | Effect |
| --- | --- | --- | --- |
| Dimming around your focus | `editor.focus` | `soft` | Opacity of text outside the focus: `soft` is 0.32, `strong` is 0.13. |
| Appearance | `editor.theme` | `auto` | `auto` follows the system. `light` and `dark` override it. |
| Text size | `editor.fontSize` | `20` | Manuscript font size in pixels, 15 to 28. |
| Line length | `editor.measure` | `34` | Maximum line length in `em`, 26 to 46. |
| Keep the line you write near the middle | `editor.typewriter` | On | Scrolls when the cursor leaves the middle band of the screen, after keyboard moves only. |
| Mark spelling mistakes | `editor.spellcheck` | On | Turns the browser's spell checking on or off for the manuscript. |
| Show the thread in the margin | `editor.gutter` | On | Draws the thread and the paragraph markers left of the text. The Editor tab explains each marker. On wide windows the thread moves up to 64 px further from the text. |

Two more fields have no control in the dialog. `editor.mapOpen` stores whether the map is shown. `editor.deskFolded` stores whether the desk is folded. `editor.zen` stores whether focus mode is on.

## Usage

One record per model request, kept in the browser under the `localStorage` key `throughline.metrics` (the latest 3,000). Each record has the start time, kind (paragraph, section, whole text, question), model, time in the queue, time to the full answer, time to the first streamed token, prompt and answer tokens, the number of HTTP attempts, and the outcome. Token counts come from the server's `usage` field; when a server sends none, they are estimated at four characters per token and marked ≈.

The tab summarises them by model and by kind (median and 90th percentile time, average tokens, answer tokens per second, unusable and failed answers) and gives a short recommendation for a smaller or larger model. **Copy as CSV** copies every record; **Delete measurements** clears them.
