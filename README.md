# personalassistant

A personal assistant application built with JavaScript.

## Getting Started

```bash
npm install
npm start
```

## ARIA HUD (browser app)

`public/` contains a browser-based voice assistant HUD backed by the Gemini API,
with object detection, timers/alarms, and Mermaid diagram/image rendering.

Structure:
- `public/index.html` — page markup
- `public/css/styles.css` — HUD styling
- `public/js/` — ES modules, one per concern (state, audio, camera, widgets, speech, gemini API, visual panel, main wiring)

It uses native ES modules, so it must be served over HTTP (not opened via `file://`):

```bash
npx serve public
# or
python -m http.server --directory public
```

Then open the printed local URL and enter a Gemini API key in the header to start.
