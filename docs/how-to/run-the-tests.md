# How to run the tests

## Run the unit tests

```sh
npm test
```

Vitest runs the specs in `test/` against the framework-free core in `src/app/core`, with jsdom as the DOM. The specs read the documents in `test/fixtures`.

To rerun on every change, run `npm run test:watch`.

## Check the types

```sh
npm run typecheck
```

The command checks the app with `tsconfig.app.json` and the tests with `tsconfig.spec.json`. `ng build` also checks the templates.

## Run the specs in a real browser

jsdom has no editing engine, no layout and no CSS Custom Highlight API, so a few behaviours differ from a browser. `tools/browser-test` runs the same spec files in Chromium.

1. Install Playwright for Python and its Chromium.

	```sh
	pip install playwright
	python -m playwright install chromium
	```

2. Bundle the specs. `tools/browser-test/vitest-shim.ts` stands in for the parts of Vitest the specs use.

	```sh
	npx esbuild tools/browser-test/run.ts --bundle --format=esm --platform=browser --alias:vitest=./tools/browser-test/vitest-shim.ts --outfile=tools/browser-test/out.js
	```

3. Run them.

	```sh
	python tools/browser-test/run_tests.py
	```

	The last line reads `35 of 35 passed | page errors: none`.

## Add a fixture

Put the document into `test/fixtures` and read it with `fixture('name.docx')` from `#fixtures`. Name the file after what it contains, for example `footnote.odt`, not after the bug it reproduces.
