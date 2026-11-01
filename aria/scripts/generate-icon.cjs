// Renders aria/electron/assets/aria-mark.svg (the blue triangle-"A" brand
// mark on black) into a 256x256 app icon PNG (aria/electron/assets/
// aria-icon.png) using Electron's own Chromium as the rasterizer — no
// SVG->PNG dependency (sharp/resvg) is installed, and the platform browser
// via Playwright may not have its binary downloaded.
//
// Run from aria/:  npx electron scripts/generate-icon.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const SVG_PATH = path.join(__dirname, '..', 'electron', 'assets', 'aria-mark.svg');
const OUT_PATH = path.join(__dirname, '..', 'electron', 'assets', 'aria-icon.png');
const SIZE = 256;

app.whenReady().then(async () => {
  const svg = fs.readFileSync(SVG_PATH, 'utf8');
  // Stroke weight lives in the file itself (the wireframe trace needs a
  // same-color stroke to stay legible at 16-24px taskbar size).
  const svgDataUri = 'data:image/svg+xml;base64,' + Buffer.from(svg, 'latin1').toString('base64');

  // Full-bleed black square, mark at 88% centered — matches the brand
  // reference (blue triangle-A on black), legible at 16px taskbar size.
  const html = `<!DOCTYPE html>
<html>
<body style="margin:0;background:transparent;">
  <div style="width:${SIZE}px;height:${SIZE}px;box-sizing:border-box;overflow:hidden;
              background:#000000;
              display:flex;align-items:center;justify-content:center;">
    <img src="${svgDataUri}" style="width:88%;height:88%;display:block;" />
  </div>
</body>
</html>`;

  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: { offscreen: true }
  });

  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));

  // Let the image decode/all raster settle before capture.
  await win.webContents.executeJavaScript('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
  await new Promise(r => setTimeout(r, 150));

  const image = await win.webContents.capturePage();
  fs.writeFileSync(OUT_PATH, image.toPNG());
  console.log('[ICON] written', OUT_PATH, image.getSize());
  app.quit();
}).catch((e) => {
  console.error('[ICON] failed:', e);
  app.quit(1);
});
