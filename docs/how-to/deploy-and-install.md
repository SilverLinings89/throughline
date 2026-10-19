# How to deploy and install Throughline

## Build the app

```sh
npm run build
```

The build writes a static site to `dist/throughline/browser`, including the service worker `ngsw-worker.js` and the web app manifest.

## Host it

Copy `dist/throughline/browser` to any static web server. The server needs no special routes, because the app has one page.

- Serve it over HTTPS. Browsers install apps and run service workers only on HTTPS or on `localhost`.
- To host it in a subfolder such as `/throughline/`, build with `npx ng build --base-href /throughline/`.
- To try a build on your machine, run `npm run preview` and open `http://localhost:8080`.

The model server stays on each writer's own computer. See [How to connect a local model](connect-a-model.md) for the browser permission a hosted app needs.

## Install it

1. Open the hosted address in Chrome or Edge.
2. Click the install icon at the right of the address bar, then **Install**.

Throughline opens in its own window and works offline. In Chrome and Edge on the desktop, the installed app also appears under **Open with** for `.docx`, `.odt`, `.md` and `.txt` files.

## Update it

Deploy a new build. The next time a writer opens Throughline, the service worker loads the new version in the background and a banner offers **Reload now**. Unsaved work survives the reload as a draft.
