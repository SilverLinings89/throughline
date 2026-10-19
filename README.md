# Throughline

Throughline is a focus editor for long-form writing. It opens Word and OpenDocument files, keeps you on one paragraph at a time, and has a language model on your own computer read along in the background. The model never writes for you. It tells you whether each paragraph serves its section, where the line of thought breaks, and which words to cut or change.

Throughline is an installable web app (a PWA) built with Angular 22. It runs offline once installed. It sends text only to the model server you configure, which is normally on your own machine.

## What it does

- Opens and saves `.docx`, `.odt`, `.md` and `.txt`. Paragraphs you did not edit are written back byte for byte, so tables, images, footnotes, comments and Word styles survive.
- Shows the document as a map: headings, keywords from the model, and a one-line summary of each paragraph in the section you are in.
- Draws a red thread through the margin. The thread turns dashed where a paragraph does not follow from the one before, and a paragraph's marker moves off the line when it strays from its section.
- Dims everything outside your focus. You switch between document, section, paragraph and sentence.
- Marks words to cut or change, unclear phrases, repetitions and breaks with your style guide, directly in the text, when you open the lens.
- Stores readings inside the file and in the browser, keyed by the exact text. A paragraph is read once, even after the file was edited in Word.

## Quick start

You need Node.js 22.12 or later and an OpenAI-compatible model server such as Ollama or LM Studio.

1. Install the dependencies.

	```sh
	npm install
	```

2. Start the development server.

	```sh
	npm start
	```

3. Open `http://localhost:4200`.
4. Click **Choose a model** in the top bar, pick your server, and click **Check connection**.
5. Click **Load a sample text** in the map to see the readings arrive.

The tutorial [Write your first section with feedback](docs/tutorials/first-session.md) walks through the same steps with a model download and expected results.

## Build and install

```sh
npm run build
npm run preview
```

`npm run build` writes the app to `dist/throughline/browser`. Any static web server can host that folder. To install the app, open it in Chrome or Edge and click the install icon in the address bar. See [How to deploy and install Throughline](docs/how-to/deploy-and-install.md).

## Documentation

The documentation follows the [Diátaxis](https://diataxis.fr) structure. [docs/README.md](docs/README.md) lists every page.

| You want to | Read |
| --- | --- |
| Learn the editor by using it | [Write your first section with feedback](docs/tutorials/first-session.md) |
| Connect Ollama, LM Studio, llama.cpp or Jan | [How to connect a local model](docs/how-to/connect-a-model.md) |
| Work on a file that others edit in Word | [How to work with Word and LibreOffice files](docs/how-to/round-trip-with-word.md) |
| Look up a setting, a shortcut or the file format | [Reference](docs/README.md#reference) |
| Understand why it works the way it does | [Explanation](docs/README.md#explanation) |

## Project layout

```text
src/app/core/        Framework-free logic: formats, zip, analysis, AI engine, editor DOM. Fully unit-tested.
src/app/services/    Angular services: state in signals, scheduling, files, drafts, PWA.
src/app/ui/          Angular components: map, desk, editor surface, lens, top bar, settings.
src/app/workers/     The Web Worker that talks to the model.
test/                Vitest specs and the documents they read.
docs/                Tutorial, how-to guides, reference and explanation.
tools/browser-test/  Runs the same specs in a real browser.
```

## Status

Version 2.0.0 is an Angular rewrite of the single-file editor (1.0.0). Files saved by 1.0.0 open with their readings.

The framework-free core passes 35 tests in Chromium. Those tests cover the file formats, the compatibility with 1.0.0 files, the reading keys, the AI engine and the editor's DOM handling. The Angular layer passes a strict TypeScript check against stand-in declarations of Angular's types. It has not been compiled with the Angular CLI or run as a whole yet, so run `npm run build` and `npm test` first and expect to fix small template errors. See [How to run the tests](docs/how-to/run-the-tests.md).

## License

No license is chosen yet. Add a `LICENSE` file before you publish the code.
