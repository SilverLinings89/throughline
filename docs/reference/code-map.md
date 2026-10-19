# Code map

## Layers

| Folder | Depends on | Content |
| --- | --- | --- |
| `src/app/core` | The browser only | Formats, zip, XML, structure, readings, prompts, the AI engine, editor DOM helpers, storage. No Angular imports. |
| `src/app/workers` | `core` | The Web Worker entry point. |
| `src/app/services` | `core`, Angular | State in signals, scheduling, files, drafts, PWA behaviour. |
| `src/app/ui` | `services`, `core`, Angular | Components. |

## Core

| Module | Exports |
| --- | --- |
| `core/model.ts` | `Block`, `SaveBlock`, `Run`, `TextRun`, `TokenRun`, `BlockMeta`, `DocSettings`, `DocFormat` |
| `core/zip/zip-archive.ts` | `ZipArchive`: `open`, `bytes`, `text`, `set`, `delete`, `build`. `crc32`. |
| `core/xml/xml.ts` | `parseXml`, `serializeXml`, `childElement`, `childElements`, `ensureRootNamespace`, `resolvePath`, `jsonForXml`, `replaceElementContent` |
| `core/formats/formats.ts` | `formatOf`, `readDocument`, `writeDocument`, `blankContext`, `MIME` |
| `core/formats/docx.ts` | `readDocx`, `writeDocx`, `blankDocx`, `DocxContext` |
| `core/formats/odt.ts` | `readOdt`, `writeOdt`, `blankOdt`, `OdtContext` |
| `core/formats/markdown.ts` | `readMarkdown`, `writeMarkdown`, `parseInline` |
| `core/formats/plain-text.ts` | `readPlainText`, `writePlainText`, `splitParagraphs` |
| `core/analysis/structure.ts` | `buildStructure`, `Structure`, `Section`, `StructBlock` |
| `core/analysis/readings.ts` | `parseReading`, `parseEmbeddedData`, `kindOfKey`, reading types |
| `core/analysis/prompts.ts` | `paragraphPrompt`, `sectionPrompt`, `documentPrompt`, `chatPrompt`, `SCHEMAS`, `PROMPT_VERSION` |
| `core/analysis/issues.ts` | `locateIssues`, `issueId` |
| `core/text/text.ts` | `sentencesOf`, `localChecks`, `findQuote`, `quoteLength` |
| `core/ai/protocol.ts` | `WorkerCommand`, `WorkerEvent`, `Job`, `AiConfig`, `URGENT` |
| `core/ai/engine.ts` | `AiEngine`, `parseModelJson`, `stripThinking`, `modelIds` |
| `core/editor/dom.ts` | `renderBlocks`, `domRuns`, `signature`, `blockText`, `rangeFor`, `offsetOf`, `normalizeEditor`, `setBlockType`, `applyShortcut`, `htmlToBlocks`, `paste` |
| `core/storage/idb.ts` | `KeyValueDb` with the stores `cache` and `drafts` |
| `core/platform.ts` | `openPicker`, `savePicker`, `launchQueue`, `canWrite`, `droppedFileHandle`, `isStoredHandle` |

## Services

| Service | Owns |
| --- | --- |
| `SettingsStore` | `ai` and `editor` settings. Saves them to `localStorage` on every change. |
| `DocumentStore` | The open file, its document settings, the dirty flag, ignored suggestions, hidden notes, and the package context. |
| `EditorService` | The contenteditable element. `structure`, `position`, `sentence`, `layer`, `lensOpen`, `filters`. Loading, saving blocks, applying suggestions, highlights. |
| `ReadingCache` | Readings in memory and IndexedDB. `version` changes on every new reading. Fallbacks to the last reading of an edited paragraph or section. |
| `AiClient` | The worker. `queued`, `running`, `offline`, `lastError`, `ready`. Validates readings, tracks failures, runs the connection check. |
| `AnalysisService` | What to read next (`schedule`), view data for the lens (`inspection`), chat (`ask`), embedded data. |
| `FilesService` | Open, save, save as, new, sample, reload after outside changes. |
| `DraftService` | Draft autosave every five seconds and the restore banner. |
| `PwaService` | Update banners and files passed in by the operating system. |
| `Notifier` | Toasts and banners. |
| `UiState` | Desk tab, settings tab, chat, narrow-screen state. |

## Components

| Component | Selector | Shows |
| --- | --- | --- |
| `App` | `tl-root` | Layout, shortcuts, drag and drop, theme. |
| `MapPanel` | `tl-map` | File actions, title, main line, outline with gists. |
| `DeskPanel` | `tl-desk` | Line, Notes and Ask tabs. |
| `TopBar` | `tl-top-bar` | Breadcrumb and layer switch, paragraph type, lens button, model status. |
| `EditorSurface` | `tl-editor` | The manuscript, the margin thread and the formatting bubble. |
| `LensPanel` | `tl-lens` | The paragraph under the cursor up close. |
| `SettingsDialog` | `tl-settings` | The three settings tabs. |
| `Notices` | `tl-notices` | Banner and toast. |

## Worker protocol

The app sends `WorkerCommand` messages and receives `WorkerEvent` messages. Both are plain data.

| Command | Effect |
| --- | --- |
| `config` | Sets the server, model and limits. Resets the remembered structured-answer mode when the server or the mode setting changes. |
| `enqueue` | Adds or replaces jobs by key. A job with priority `URGENT` (1000) goes first and starts even while typing holds the queue; running jobs are never interrupted. |
| `priority` | Changes the priority of queued jobs. |
| `cancel` | Drops queued jobs and aborts running ones. |
| `hold` | Starts no new non-urgent job for the given milliseconds. |
| `clear` | Drops and aborts everything. |

| Event | Meaning |
| --- | --- |
| `status` | Number of queued jobs and the running jobs. |
| `format` | The structured-answer mode that worked. |
| `chunk` | Streamed chat text so far. |
| `done` | A job finished. `result` is parsed JSON for readings and text for the chat. |
| `error` | A job failed. `cancelled` is true when the app cancelled it. |
