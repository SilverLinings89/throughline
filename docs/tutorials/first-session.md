# Write your first section with feedback

In this tutorial, we set up a model on your computer, start Throughline, and get feedback on a sample text. At the end, we open one of your own files. It takes about 20 minutes, most of it for the model download.

We use Ollama, because it runs on Windows, macOS and Linux. Other servers work the same way, see [How to connect a local model](../how-to/connect-a-model.md).

## Install a model

1. Install Ollama from [ollama.com](https://ollama.com).
2. Download a model. `qwen3:8b` needs about 6 GB of disk and runs on most laptops from the last few years.

	```sh
	ollama pull qwen3:8b
	```

	The download ends with `success`.

3. Quit Ollama if it runs in the background. On macOS and Windows, use the icon in the menu bar or the system tray.
4. Start Ollama so that it accepts requests from a web page and reads longer texts.

	On macOS and Linux:

	```sh
	OLLAMA_ORIGINS="*" OLLAMA_CONTEXT_LENGTH=16384 ollama serve
	```

	On Windows, in PowerShell:

	```powershell
	$env:OLLAMA_ORIGINS="*"; $env:OLLAMA_CONTEXT_LENGTH="16384"; ollama serve
	```

	Leave this window open. It prints one log line for every request the editor sends.

## Start Throughline

1. In the project folder, install the dependencies and start the app.

	```sh
	npm install
	npm start
	```

	The last line reads `Local: http://localhost:4200/`.

2. Open `http://localhost:4200` in Chrome or Edge.

You see an empty page with a red cursor. The top bar on the right says **Choose a model**.

## Connect the model

1. Click **Choose a model**. The settings open on the **Model** tab.
2. Click **Ollama** below the server address.
3. Click **Check connection**. The line next to the button reads `Connected. 1 model available.`, and the **Model** field now says `qwen3:8b`.
4. Close the settings.

The top bar now says **Up to date**.

## Read the sample text

1. In the map on the left, click **Load a sample text**.

	The text is about social democracy. It has an introduction and two parts. One paragraph in **Solidarity as practice** talks about coffee houses and has nothing to do with the section. We want the model to find it.

2. Watch the top bar. It says **Reading** followed by a section or a paragraph, and how many readings are waiting.

	A small model needs 5 to 30 seconds per reading. After a minute or two, keywords appear under each heading in the map.

3. Click **Solidarity as practice** in the map.

	The section opens in the map with a one-line summary of each paragraph. The red thread runs down the left of these lines.

4. Look at the third line, about coffee houses. Its bead sits off the thread, and in the editor margin the thread is dashed next to that paragraph. The model found the paragraph that strays.

	If the model rated the paragraph differently, the bead stays on the line. Small models vary. Try again with **Read this paragraph again** in the lens later.

5. Look at the desk below the map. The **Line** tab shows how well the section holds together, the section's line of thought in one sentence, and the paragraph where the line breaks.

## Work on one paragraph

1. Click into the coffee house paragraph. Everything else dims.
2. Press `Ctrl+.` (`Cmd+.` on a Mac). The lens opens on the right.

	It shows what the paragraph claims, a sentence on its flow, and scores for clarity and for how well it serves the section. Below are the model's suggestions. In the text, words to cut are struck through and words to change are underlined.

3. Click **Replace** or **Delete** on one suggestion. The text changes. `Ctrl+Z` undoes it.
4. Click the breadcrumb **Sentence 1 of 2** at the top. Only the sentence you are in stays dark.
5. Click **Paragraph** in the breadcrumb to go back.

## Give the text a line

1. Click the title **Introduction** at the top of the map. The document settings open.
2. The **Main line of thought** already holds the sample's line. Change it to something else, for example `Social democracy is a compromise between capitalism and socialism.`
3. Close the settings and wait.

	The sections are read again against the new line. The coffee house paragraph still strays, and the introduction now contradicts your line. The **Notes** tab on the desk says so.

## Save and reopen

1. Press `Ctrl+S`. Chrome asks where to save. Save the file as `sample.docx`.
2. Open `sample.docx` in Word or LibreOffice. It is an ordinary document.
3. Close it. In Throughline, press `Ctrl+O` and open `sample.docx` again.

	The keywords and summaries are there at once, and the top bar says **Up to date**. The readings were saved inside the file, so nothing is read twice.

## Open your own file

Press `Ctrl+O` and open one of your own `.docx` or `.odt` files. The model starts with the paragraph you are in, then your section, then the rest. For a book, the first pass takes hours on a laptop. You can write the whole time, because the model only starts new readings when you pause.

From here, [How to work with Word and LibreOffice files](../how-to/round-trip-with-word.md) explains what happens to tables, images and edits made elsewhere.
