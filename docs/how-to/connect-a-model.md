# How to connect a local model

Throughline talks to any server with an OpenAI-compatible `/v1/chat/completions` endpoint. The browser sends the requests directly, so the server must allow requests from the page's address. That permission is called CORS.

## Set up the server

### Ollama

1. Quit Ollama if it runs in the background.
2. Start it with CORS allowed and a context long enough for whole sections.

	```sh
	OLLAMA_ORIGINS="*" OLLAMA_CONTEXT_LENGTH=16384 ollama serve
	```

	To allow only your Throughline address, put that address in `OLLAMA_ORIGINS` instead of `*`, for example `OLLAMA_ORIGINS="https://write.example.org"`.

3. In Throughline, open **Settings**, then **Model**, and click **Ollama**. The address becomes `http://localhost:11434/v1`.

Without `OLLAMA_CONTEXT_LENGTH`, Ollama cuts long prompts short and section readings lose paragraphs without an error.

### LM Studio

1. Load a model and open the **Developer** tab.
2. Start the server and switch on **Enable CORS** in its settings.
3. In Throughline, click **LM Studio**. The address becomes `http://localhost:1234/v1`.

### llama.cpp

1. Start the server with a model file.

	```sh
	llama-server -m model.gguf --port 8080 -c 16384
	```

2. In Throughline, click **llama.cpp**. The address becomes `http://localhost:8080/v1`.

### Jan

1. Start the local API server in Jan's settings and allow CORS there.
2. In Throughline, click **Jan**. The address becomes `http://localhost:1337/v1`.

### Another server

Type the address of the API, ending in `/v1`, into **Server address**. If the server needs a key, put it into **API key**. The key is stored in this browser only and sent as a `Bearer` token.

## Choose the model

1. Click **Check connection**. The list under **Model** fills with the models the server offers.
2. Pick a model.

Models of 8 to 14 billion parameters are a good balance. Smaller models miss more and copy quotes less exactly, so fewer suggestions can be placed in the text. Reasoning models work. Throughline removes their `<think>` blocks.

## Allow local network access for a hosted app

If you open Throughline from a server on the internet, Chrome and Edge ask once whether the site may connect to devices on your local network. Click **Allow**. Throughline triggers the question when it starts and when you click **Check connection**.

If you run Throughline from `localhost`, there is no question.

## Fix common problems

| The top bar says | Cause | Fix |
| --- | --- | --- |
| **Choose a model** | The **Model** field is empty. | Click **Check connection** and pick a model. |
| **Model unreachable** | The server does not run, or it refuses requests from this page. | Start the server. Check the CORS setting for your server above. Hover over the status to see the browser's message. |
| **Last reading failed** | The server answered with an error, often an unknown model name. | Hover over the status to read the error. Check the model name. |
| **Reading …** for minutes | The model is slow or the text per request is large. | Lower **Text per section request**, raise **Time limit**, or use a smaller model. |
| No suggestions appear in the text | The model paraphrases instead of quoting. | Use a larger model, or a lower **Temperature**. |

If the server rejects structured answers, set **Structured answers** to **JSON mode** or **Plain text**. **Find out automatically** tries JSON schema, then JSON mode, then plain text, and keeps the first that works.
