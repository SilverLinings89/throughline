# About the architecture

Throughline started as a single HTML file. Version 2 is an Angular app, but most of its code still knows nothing about Angular. This page explains the decisions that shape the code and what each one costs.

## A framework-free core

Everything that does not draw the interface lives in `src/app/core`: file formats, zip, structure, readings, prompts, the AI engine, the editor's DOM helpers. These modules import nothing from Angular.

The core holds the parts that are hard to get right and easy to break: the XML of two office formats, reading keys that must match across versions, a job queue with priorities and format fallbacks. Without Angular, the core runs in any test environment and in a Web Worker, and its tests need no component setup. The 35 specs in `test/` cover it.

The cost is a seam. Services translate between plain data in the core and signals in the app, and that translation is code too.

## The manuscript stays outside Angular

The manuscript is one `contenteditable` element. Angular renders the frame around it but nothing inside it. The browser's editing engine owns the content, and `EditorService` reads it back into a `Structure` signal.

Angular's templates assume they own the DOM they render. An editing engine assumes the same. If both wrote to the manuscript, each would undo the other's work and the browser's undo history would break. Keeping Angular out of the manuscript keeps native editing: spell checking, input methods for other scripts, undo, and selection all work as in any text field.

The cost is that the manuscript is plain DOM code. `normalizeEditor` repairs what the editing engine produces, such as a list nested inside a paragraph. List conversions are written by hand, because Chrome's own list command nests lists inside paragraphs.

## One stylesheet

All styles are in `src/styles.css`. Components have no styles of their own.

The manuscript's styles cannot be encapsulated, because Angular did not render the manuscript. And every panel shares one set of colour and type tokens with the manuscript. Splitting the styles across components would scatter one design into eight files.

## Readings travel inside the file

The project brief ruled out a new file format, and a file next to the document gets lost when the document is mailed. So readings go inside the document.

In a `.docx`, they go into a custom XML part, the mechanism Word add-ins use to store their data. Word keeps such parts when it saves. In an `.odt`, they go into an extra file listed in the package manifest. LibreOffice also keeps a custom XML part when it saves a `.docx`. Whether it keeps an extra file inside an `.odt` has not been tested. If it drops the file, the readings come back from the browser's cache or from the model.

## Unchanged paragraphs are written from their original XML

Rebuilding a whole `.docx` from the editor's simple model would lose everything the editor does not understand. So the writer rebuilds only paragraphs whose signature changed. Every other paragraph, table and image is copied from the XML it was read from. A document opened and saved without edits keeps its body unchanged, apart from namespace declarations.

## A Web Worker for every model request

The model is slow and the editor must not be. The worker owns the queue, the network, parsing and retries. The page owns only scheduling decisions, which are cheap.

One request does not use the worker: the connection check. Chrome asks for local network access only for requests from a page. A permission the user grants there then also covers the worker.

## No dependencies at runtime besides Angular

The zip format uses the browser's `CompressionStream`. XML uses `DOMParser`. Sentences use `Intl.Segmenter`. Highlights use the CSS Custom Highlight API. The app has no editor framework, no zip library and no AI SDK. Each of those would be a large dependency for a small part of its features, and each would need updates.

The cost is browser support. The app needs a browser from 2024 or later. In older browsers, highlights do not appear and sentence splitting falls back to punctuation.
