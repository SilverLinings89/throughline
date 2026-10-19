# About background reading

The model reads three things: single paragraphs, whole sections, and the outline of the whole text. A local model needs seconds to minutes for each, and a book has thousands of paragraphs. So the app reads only what you are looking at, re-reads sections and the whole text only after substantial changes, never blocks typing, and never reads the same text twice.

## What is read, and when

`AnalysisService.schedule` runs after every structural change, when the cursor moves, and every four seconds. It decides what is due:

| Reading | When |
| --- | --- |
| The paragraph under the cursor | After the cursor has rested in it for 2 seconds (1.2 with the lens open) and you have paused typing for the time set in the Model tab. Moving through the text sends nothing. Other paragraphs are not read in the background. |
| A section | When it has no reading yet (for example after opening a file); when the main line, style guide or feedback language changed; or when a quarter of its text changed or two paragraphs came or went since its reading. The section you write in waits for 20 seconds without typing. |
| The whole text | After every section is read: when it was never read, the settings, title or headings changed, or a third of the sections got new readings. At most every ten minutes in the last case. |
| The lens's **Read this paragraph again**, and the chat | At once, ahead of everything else. |

At most three readings wait or run at any time. Queued readings that are no longer wanted are dropped. A running reading is never cancelled or interrupted, not for an edit and not for an urgent request: when its text was edited in the meantime, the answer is shown as the reading of the earlier version. One reading per paragraph or section runs at a time.

Small edits keep a section's reading, shown as from an earlier version. The change is measured by what actually differs inside edited paragraphs, so fixing a typo does not count as rewriting the paragraph.

Every request has an answer length limit: 1,500 tokens for a paragraph, 2,500 for a section or the whole text, unless **Answer length limit** is set. The JSON schemas also cap the number of suggestions, keywords and notes.

## Why typing never waits

Requests run in a Web Worker. Building the prompt, waiting for the server, parsing JSON and retrying all happen off the editor's thread.

That alone does not protect a laptop that runs the model itself. Inference competes with the browser for the processor. So while you type, the worker starts no new requests for 2.2 seconds after each keystroke. A request already running continues, because aborting it would waste the work done so far.

The rest of the app keeps its own work small. The structure is rebuilt 450 ms after you stop typing, not on every key. The margin draws only the paragraphs near the screen. The single-file version, which works the same way, was measured on a 1,500-paragraph document: with the model busy, the slowest keystroke reached the screen in 25 ms. The Angular version has not been measured yet.

## Why readings never go stale

A reading is stored under a key made from the exact text it describes, plus every setting that changes its meaning. See [Reading keys](../reference/file-formats.md#reading-keys).

- Change one word and the paragraph has a new key. The old reading stays valid for the old text.
- Undo the change and the old key comes back, with its reading.
- Edit the file in Word and reopen it: unchanged paragraphs have the same keys and their readings are found at once.

Nothing is ever invalidated, so there is no invalidation logic to get wrong. The cost is that old readings pile up in IndexedDB. They are small, and **Forget all stored readings** clears them.

While a new reading is on its way, the app shows the last reading of the edited paragraph or section, marked as from an earlier version. Its suggestions still point at the parts of the text you did not change.

## How results are trusted

A local model's JSON is often almost right. The worker strips `<think>` blocks and code fences, cuts the first JSON object out of surrounding prose, and drops trailing commas. `parseReading` then checks every field, clamps scores to their ranges and drops suggestions without a quote. A suggestion is shown only if its quote is found in the current text. Curly quotes, dash variants, spacing and case may differ.

A reading that fails these checks, and a request that hits the time limit, are not repeated for the same text: the same request would most likely fail the same way. Editing the text or **Read this paragraph again** asks again. Other failures, such as an unreachable server, wait 40 seconds, then twice as long after each further failure, and stop after four. Changing the model settings clears all of this.
