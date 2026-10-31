const { app, BrowserWindow, Tray, Menu, shell, session, ipcMain, nativeImage, safeStorage, desktopCapturer, screen } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const { fileURLToPath } = require('url');
const fs = require('fs');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { classifyUpdate } = require('./update-classify.cjs');
const { describeGoogleTokenError } = require('./google-token-error.cjs');
const mcpManager = require('./mcp-manager.cjs');

const DEV_URL = 'http://localhost:3000';
const ICON_PATH = path.join(__dirname, 'assets', 'aria-icon.png');
const SPEECH_SCRIPT_PATH = path.join(__dirname, 'speech-recognizer.ps1');

// Local loopback redirect for Spotify's Authorization Code OAuth flow — this
// exact URI must be added to the app's "Redirect URIs" in the Spotify
// Developer Dashboard (developer.spotify.com/dashboard) for login to work.
const SPOTIFY_REDIRECT_PORT = 43417;
const SPOTIFY_REDIRECT_URI = `http://127.0.0.1:${SPOTIFY_REDIRECT_PORT}/callback`;
const SPOTIFY_AUTH_SCOPES = 'playlist-read-private playlist-read-collaborative user-library-read';

// Local loopback redirect for Google's OAuth 2.0 Authorization Code + PKCE
// flow — this exact URI must be added to the "Authorized redirect URIs" of
// the Desktop-app OAuth client in Google Cloud Console for login to work.
// Gmail stays read-only (no send/modify/delete requested, so even a leaked
// token can't act on the mailbox, only read it) while calendar.events grants
// read + create access to the user's own events only — the minimal scope
// covering listing/searching events and creating them, without calendar
// list/settings management. See
// docs/superpowers/specs/2026-08-15-gmail-google-connector-design.md and
// docs/superpowers/specs/2026-08-15-google-calendar-harness-design.md.
const GOOGLE_REDIRECT_PORT = 43418;
const GOOGLE_REDIRECT_URI = `http://127.0.0.1:${GOOGLE_REDIRECT_PORT}/callback`;
const GOOGLE_AUTH_SCOPES = 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.events openid email profile';

let mainWindow = null;
let tray = null;
let micProcess = null;
// Duplicate-final suppression state — reset whenever a fresh recognizer
// spawns so a new engine's legit re-recognition isn't wrongly swallowed.
let lastFinalText = '';
let lastFinalAt = 0;
const FINAL_DUP_WINDOW_MS = 12000;
let indicatorWindow = null;
let overlayWindow = null;
app.isQuitting = false;

// Auto-download only kicks in for major bumps (see update-classify.cjs) —
// minor/patch updates wait for an explicit renderer-triggered download.
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;
let pendingUpdate = null; // { version, classification } once update-available fires
let updateReadyToInstall = false;
// Last state object sent to the renderer — replayed via 'update:get-state'
// so events fired before the renderer subscribed aren't lost.
let lastUpdateState = { status: 'idle' };

// Only one JARVIS instance/tray icon at a time.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: 'ARIA',
    icon: ICON_PATH,
    backgroundColor: '#05070c',
    autoHideMenuBar: true,
    // Start hidden — ARIA lives in the tray and listens in the background;
    // the window only appears when the user opens it from the tray icon.
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs')
    }
  });

  if (app.isPackaged) {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  } else {
    mainWindow.loadURL(DEV_URL);
  }

  if (!app.isPackaged) {
    // Surface renderer console output in the main-process terminal for debugging.
    mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
      console.log(`[renderer] ${message}`);
    });
  }

  // Keep the window pinned to the app: never let in-page links (Leaflet map
  // attributions, <a href>, etc.) navigate the Electron window away from ARIA.
  // Non-app URLs go to the OS default browser; steam:// and other custom
  // protocols also go to the OS since Electron can't resolve them.
  const APP_ORIGIN = app.isPackaged
    ? 'file://'
    : new URL(DEV_URL).origin;

  // Boundary directory for packaged file:// navigations (see isOwnOrigin).
  const APP_DIST_DIR = path.resolve(__dirname, '..', 'dist');

  // Scheme allowlist for URLs handed to shell.openExternal from renderer
  // content (page links, window.open, crafted game/site titles). Everything
  // else — file://, \\UNC paths, unknown custom protocols — is blocked:
  // page content must never be able to invoke arbitrary protocol handlers.
  const OPENABLE_PROTOCOLS = new Set(['http:', 'https:', 'steam:', 'xbox:', 'spotify:', 'com.epicgames.launcher:']);
  const isSafeToOpen = (urlString) => {
    try {
      return OPENABLE_PROTOCOLS.has(new URL(urlString).protocol);
    } catch {
      return false;
    }
  };

  // True when `urlString` belongs to the app itself. Compares parsed origins
  // rather than string prefixes — `url.startsWith(APP_ORIGIN)` would let
  // lookalikes through (http://localhost:3000.evil.com, http://localhost:30001,
  // http://localhost:3000@evil.com). In packaged mode APP_ORIGIN is scheme-only
  // ('file://') with no host to compare, so the equivalent safe rule there is:
  // file: protocol, no host, and a resolved path that stays inside the app's
  // own dist/ directory (path.resolve also neutralizes ../ traversal).
  const isOwnOrigin = (urlString) => {
    let urlObj;
    try {
      urlObj = new URL(urlString);
    } catch {
      return false;
    }
    if (!app.isPackaged) return urlObj.origin === APP_ORIGIN;

    if (urlObj.protocol !== 'file:' || urlObj.host) return false;
    let filePath;
    try {
      filePath = fileURLToPath(urlObj);
    } catch {
      return false;
    }
    const resolved = path.resolve(filePath);
    return resolved === APP_DIST_DIR || resolved.startsWith(APP_DIST_DIR + path.sep);
  };

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isOwnOrigin(url)) return;
    event.preventDefault();
    if (isSafeToOpen(url)) shell.openExternal(url);
  });

  // window.open() calls (Google search tabs, Store search fallback, site links)
  // should open in the user's default browser, not spawn a second Electron window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeToOpen(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Closing the window minimizes to tray instead of quitting the app.
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  // Null out the handle once destroyed so every mainWindow consumer (tray,
  // second-instance, activate, sendUpdateState) can detect the dead window
  // instead of calling into a destroyed BrowserWindow.
  mainWindow.on('closed', () => { mainWindow = null; });
}

function createTray() {
  const icon = nativeImage.createFromPath(ICON_PATH);
  tray = new Tray(icon.isEmpty() ? icon : icon.resize({ width: 16, height: 16 }));
  tray.setToolTip('ARIA Voice AI');

  const menu = Menu.buildFromTemplate([
    { label: 'Show ARIA', click: () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.show();
      mainWindow.focus();
    } },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } }
  ]);
  tray.setContextMenu(menu);

  tray.on('click', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function createIndicatorWindow() {
  const workArea = screen.getPrimaryDisplay().workArea;
  const size = 16;
  const margin = 8;

  indicatorWindow = new BrowserWindow({
    width: size,
    height: size,
    x: workArea.x + workArea.width - size - margin,
    y: workArea.y + workArea.height - size - margin,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: false,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  indicatorWindow.setIgnoreMouseEvents(true, { forward: true });
  indicatorWindow.loadFile(path.join(__dirname, 'indicator.html'));

  indicatorWindow.on('closed', () => { indicatorWindow = null; });
}

function showIndicator() {
  if (!indicatorWindow) createIndicatorWindow();
  indicatorWindow.showInactive();
}

function hideIndicator() {
  if (indicatorWindow) indicatorWindow.hide();
}

function registerScreenMonitorIpc() {
  ipcMain.handle('screen:monitor-show', () => { showIndicator(); });
  ipcMain.handle('screen:monitor-hide', () => { hideIndicator(); });
}

function showOverlay() {
  console.log('[OVERLAY] showOverlay called');
  // Recreate from scratch on every show so a wedged overlay (stale IPC, dead
  // renderer state left over from previous hot reloads / long sessions) can
  // never persist — showing the overlay is always a fresh boot of it.
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.destroy();
    overlayWindow = null;
  }
  createOverlayWindow();
  overlayWindow.show();
  console.log('[OVERLAY] Window shown');
}

// Horizontal bar dimensions — must match the CSS vars in overlay.html
const OVERLAY_BAR_W = 460;
const OVERLAY_BAR_H = 64;
const OVERLAY_EXPANDED_H = 380;

function createOverlayWindow() {
  const workArea = screen.getPrimaryDisplay().workArea;

  overlayWindow = new BrowserWindow({
    width: OVERLAY_BAR_W,
    height: OVERLAY_BAR_H,
    x: workArea.x + 20,
    y: workArea.y + 20,
    frame: false,
    transparent: false,
    backgroundColor: '#0d1629',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: true,
    show: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs')
    }
  });

  overlayWindow.setIgnoreMouseEvents(false);
  overlayWindow.loadFile(path.join(__dirname, 'overlay.html')).catch(err => {
    console.error('[OVERLAY] Failed to load overlay.html:', err);
  });
  console.log('[OVERLAY] Window created, loading overlay.html...');

  overlayWindow.webContents.on('did-finish-load', () => {
    console.log('[OVERLAY] overlay.html loaded successfully');
  });

  overlayWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    console.error('[OVERLAY] Failed to load:', errorCode, errorDescription);
  });

  overlayWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    console.log(`[OVERLAY RENDERER] ${message}`);
  });
  overlayWindow.on('closed', () => { overlayWindow = null; });
}

function hideOverlay() {
  if (overlayWindow) {
    overlayWindow.hide();
    console.log('[OVERLAY] Window hidden');
  }
}

ipcMain.handle('screen:toggle-overlay', (event, visible) => {
  if (visible) showOverlay();
  else hideOverlay();
  return { success: true };
});

ipcMain.handle('screen:overlay-state', () => {
  if (overlayWindow && overlayWindow.isVisible()) return 'Overlay is visible and capturing';
  else if (overlayWindow) return 'Overlay is hidden';
  else return 'No overlay window';
});

// Overlay <-> ARIA communication relay
ipcMain.handle('overlay:send-message', (event, { text }) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('overlay:message', { text });
  }
  return { success: true };
});

ipcMain.on('overlay:response', (event, { text }) => {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('overlay:response', { text });
  }
});

ipcMain.handle('overlay:toggle-ready', () => {
  // Just acknowledge overlay window is ready
  return { success: true };
});

ipcMain.handle('overlay:resize', (event, { width, height }) => {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.setSize(width, height);
  }
  return { success: true };
});

function configureAutoLaunch() {
  // Only meaningful for an installed build — dev runs point at the Electron
  // binary itself, which isn't something useful to auto-launch at login.
  if (!app.isPackaged) return;
  app.setLoginItemSettings({
    openAtLogin: true,
    path: process.execPath
  });
}

// Voice input: Electron's Chromium build has no proprietary Google speech
// backend, so the browser's SpeechRecognition API always fails with a
// "network" error here. Instead, run Windows' own on-device dictation
// (System.Speech via PowerShell) in a child process and stream results back
// over IPC — free, local/private, no API key, works offline.
function stopMic(notifyRenderer = false) {
  if (micProcess) {
    try { micProcess.kill(); } catch (e) {}
    micProcess = null;
  }
  if (notifyRenderer && mainWindow) {
    mainWindow.webContents.send('mic:status', { status: 'stopped', message: 'Voice listening paused' });
  }
}

function startMic(force = false) {
  if (micProcess) {
    if (!force) return; // already running
    // Force restart: a long-lived recognizer can go deaf (SAPI engine stall,
    // stuck suppress state, or a stale process from before a renderer reload
    // re-armed listening). A forced start gets a guaranteed-fresh engine.
    try { micProcess.kill(); } catch (e) {}
    micProcess = null;
  }

  micProcess = spawn('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SPEECH_SCRIPT_PATH
  ], { windowsHide: false });

  let buffer = '';
  micProcess.stdout.setEncoding('utf8');
  micProcess.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) continue;

      let msg;
      try {
        msg = JSON.parse(line);
      } catch (e) {
        continue; // ignore any non-JSON PowerShell noise
      }

      if (!mainWindow) continue;

      if (msg.type === 'ready') {
        mainWindow.webContents.send('mic:status', { status: 'listening', message: 'Listening for voice input (Windows Speech)...' });
      } else if (msg.type === 'final' || msg.type === 'interim') {
        console.log(`[MIC] ${msg.type}: ${JSON.stringify(msg.text)}`);
        if (msg.type === 'final') {
          // SAPI re-emits the same final transcript several times (reco
          // restarts re-tag the last utterance); without this guard every
          // re-emit re-dispatches the same command (8x screenshots, 8x TTS).
          const key = String(msg.text || '').trim().toLowerCase();
          const now = Date.now();
          if (key && key === lastFinalText && now - lastFinalAt < FINAL_DUP_WINDOW_MS) {
            console.log('[MIC] suppressed duplicate final (SAPI re-emit)');
            continue;
          }
          lastFinalText = key;
          lastFinalAt = now;
        }
        mainWindow.webContents.send('mic:transcript', { text: msg.text, isFinal: msg.type === 'final', alternatives: msg.alternatives || [] });
      } else if (msg.type === 'error') {
        console.warn('[MIC] recognizer error:', msg.message);
        mainWindow.webContents.send('mic:status', { status: 'error', message: `Windows Speech Recognition error: ${msg.message}` });
        stopMic();
      }
    }
  });

  micProcess.stderr.setEncoding('utf8');
  micProcess.stderr.on('data', (chunk) => {
    console.warn('[speech-recognizer stderr]', chunk);
  });

  micProcess.on('exit', (code) => {
    const hadProcess = micProcess !== null;
    micProcess = null;
    if (hadProcess && code !== 0 && code !== null && mainWindow) {
      mainWindow.webContents.send('mic:status', {
        status: 'error',
        message: `Windows Speech Recognition exited unexpectedly (code ${code}). Check that Windows Speech Recognition is available on this PC, then click the mic button to retry.`
      });
    }
  });

  micProcess.on('error', (err) => {
    micProcess = null;
    if (mainWindow) {
      mainWindow.webContents.send('mic:status', { status: 'error', message: `Failed to start Windows Speech Recognition: ${err.message}` });
    }
  });
}

function registerMicIpc() {
  ipcMain.handle('mic:start', (event, { force } = {}) => { startMic(force); });
  ipcMain.handle('mic:stop', () => { stopMic(true); });
}

function registerScreenCaptureIpc() {
  ipcMain.handle('screen:capture-primary', async () => {
    try {
      const primaryDisplay = screen.getPrimaryDisplay();
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1920, height: 1080 }
      });

      const primarySource = sources.find(s => s.display_id === String(primaryDisplay.id)) || sources[0];
      if (!primarySource || primarySource.thumbnail.isEmpty()) {
        return { success: false, error: 'No screen source available to capture.' };
      }

      const dataUrl = `data:image/jpeg;base64,${primarySource.thumbnail.toJPEG(80).toString('base64')}`;
      return { success: true, dataUrl };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });
}

function registerSteamIpc() {
  // Runs in the main process, so it's a plain Node HTTPS request — not subject
  // to browser CORS at all. Replaces the dev-only Vite proxy / public CORS
  // proxy fallback used when this app runs as a regular browser tab.
  ipcMain.handle('steam:fetch-owned-games', (event, { apiKey, steamId }) => {
    const url = `https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/?key=${encodeURIComponent(apiKey)}&steamid=${encodeURIComponent(steamId)}&include_appinfo=1&format=json`;
    return new Promise((resolve, reject) => {
      https.get(url, (res) => {
        let data = '';
        res.on('data', (chunkData) => { data += chunkData; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(new Error('Invalid JSON returned from Steam API'));
            }
          } else {
            reject(new Error(`Steam API HTTP ${res.statusCode}`));
          }
        });
      }).on('error', reject);
    });
  });
}

function registerGameLibraryIpc() {
  const fsPromises = fs.promises;

  // Reads Epic Games Launcher's local install manifests (one .item JSON file
  // per installed game) — no network call, no credentials needed.
  ipcMain.handle('epic:get-installed-games', async () => {
    const manifestsDir = path.join(process.env.ProgramData || 'C:\\ProgramData', 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests');
    try {
      const files = await fsPromises.readdir(manifestsDir);
      const games = [];
      for (const file of files) {
        if (!file.endsWith('.item')) continue;
        try {
          const raw = await fsPromises.readFile(path.join(manifestsDir, file), 'utf8');
          const m = JSON.parse(raw);
          if (m.DisplayName && m.AppName && m.CatalogNamespace && m.CatalogItemId) {
            games.push({
              displayName: m.DisplayName,
              appName: m.AppName,
              catalogNamespace: m.CatalogNamespace,
              catalogItemId: m.CatalogItemId
            });
          }
        } catch (e) {
          // One malformed/unreadable manifest shouldn't fail the whole scan.
        }
      }
      return games;
    } catch (e) {
      // Epic not installed, or manifests folder doesn't exist yet.
      return [];
    }
  });

  // Get-AppxPackage narrows to real Store-signed packages (excludes
  // frameworks/resource packages/system components); Get-StartApps gives
  // the human-friendly display name. execFile (not exec) passes the script
  // as a single argument, not a shell-interpolated string — no injection
  // surface, no manual quote-escaping needed.
  ipcMain.handle('xbox:get-installed-games', () => {
    return new Promise((resolve) => {
      const { execFile } = require('child_process');
      const script = [
        '$pkgs = Get-AppxPackage | Where-Object { -not $_.IsFramework -and -not $_.IsResourcePackage -and $_.SignatureKind -eq \'Store\' }',
        '$apps = Get-StartApps',
        '$out = foreach ($p in $pkgs) {',
        '  $m = $apps | Where-Object { $_.AppID -like "$($p.PackageFamilyName)!*" } | Select-Object -First 1',
        '  if ($m) { [PSCustomObject]@{ Name = $m.Name; AppID = $m.AppID } }',
        '}',
        '$out | ConvertTo-Json -Compress'
      ].join('\n');

      execFile(
        'powershell.exe',
        ['-NoProfile', '-Command', script],
        { timeout: 8000, windowsHide: true },
        (err, stdout) => {
          if (err || !stdout || !stdout.trim()) { resolve([]); return; }
          try {
            let parsed = JSON.parse(stdout);
            if (!Array.isArray(parsed)) parsed = [parsed];
            resolve(parsed.filter(a => a && a.Name && a.AppID).map(a => ({ name: a.Name, appId: a.AppID })));
          } catch (e) {
            resolve([]);
          }
        }
      );
    });
  });

  // Launches an installed Xbox/Store app by its AppUserModelID. shell:AppsFolder
  // isn't a registered URL protocol (unlike xbox:/com.epicgames.launcher://),
  // so it can't be opened via window.location.href from the renderer.
  //
  // Verified empirically on a real machine that shell.openExternal (which
  // goes through ShellExecute under the hood, same as PowerShell's bare
  // Start-Process "shell:...") does NOT reliably resolve shell:AppsFolder
  // paths — it returns/resolves without error but no process launches.
  // Spawning explorer.exe with the shell path as an argument does launch it
  // reliably (confirmed: shell:AppsFolder\SupergiantGamesLLC.HadesII_...!Game
  // actually started Hades II this way, not via shell.openExternal). This is
  // a known Windows quirk — explorer.exe has its own shell-namespace
  // resolution that ShellExecute alone doesn't reliably trigger for
  // AppsFolder paths specifically.
  //
  // appId always comes from XboxLibrary's own PowerShell-enumerated results
  // in the intended flow, but the IPC channel itself is reachable with any
  // string a renderer-side script supplies, so validate the shape (real
  // AppUserModelIDs look like "PackageFamilyName!AppId") before it reaches
  // execFile. execFile (not exec) passes the path as an argument, not a
  // shell-interpolated string — no injection surface.
  ipcMain.handle('xbox:launch-app', (event, { appId }) => {
    if (typeof appId !== 'string' || !/^[A-Za-z0-9_.]+![A-Za-z0-9_.]+$/.test(appId)) {
      return { success: false };
    }
    return new Promise((resolve) => {
      const { execFile } = require('child_process');
      execFile('explorer.exe', [`shell:AppsFolder\\${appId}`], (err) => {
        // explorer.exe reliably exits non-zero even on a successful launch
        // (it's just relaying the request, not staying attached to the
        // launched app) — treat any execFile-level failure to even spawn
        // explorer.exe as the real failure signal, not its exit code.
        resolve({ success: true });
      });
    });
  });
}

function registerWeatherIpc() {
  // Same plain-Node-HTTPS-in-main-process trick as registerWolframIpc, to avoid
  // browser CORS entirely for the packaged app. Open-Meteo is a free, keyless
  // weather API — no credentials needed. Takes lat/lon from the renderer's
  // geolocation and returns the current conditions.
  ipcMain.handle('weather:current', (event, { lat, lon }) => {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(lat)}` +
      `&longitude=${encodeURIComponent(lon)}` +
      `&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day`;
    return new Promise((resolve, reject) => {
      https.get(url, (res) => {
        let data = '';
        res.on('data', (chunkData) => { data += chunkData; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(data));
            } catch (err) {
              reject(new Error(`Invalid Open-Meteo response: ${err.message}`));
            }
          } else {
            reject(new Error(`Open-Meteo API HTTP ${res.statusCode}`));
          }
        });
      }).on('error', reject);
    });
  });
}

// --- Maps: nearby places & driving directions (free/keyless OSM stack) ---
// Nearby-place search uses Overpass (OpenStreetMap tag queries); geocoding
// uses Nominatim; routing uses OSRM's public demo server. All three are free
// and keyless but rate-limited and intended for light, non-bulk personal use
// (fine for a single assistant user; a self-hosted/paying instance would be
// needed at scale). Plain Node HTTPS in the main process — same trick as the
// weather/wolfram handlers — avoids renderer CORS entirely.

function httpsGetJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Invalid JSON: ${e.message}`));
        }
      });
    }).on('error', reject);
  });
}

function httpsPostJson(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(body), ...headers }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Invalid JSON: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// A keyword -> OpenStreetMap tag filter map, so "pizza" / "coffee" / "gas"
// resolve to real OSM tags. Anything not in the map falls back to a
// case-insensitive name-substring match instead.
const NEARBY_TAG_MAP = {
  pizza: ['amenity=restaurant', 'amenity=fast_food', 'amenity=pizza'],
  restaurant: ['amenity=restaurant', 'amenity=fast_food'],
  food: ['amenity=restaurant', 'amenity=fast_food', 'amenity=cafe'],
  eat: ['amenity=restaurant', 'amenity=fast_food', 'amenity=cafe'],
  coffee: ['amenity=cafe', 'shop=coffee'],
  cafe: ['amenity=cafe'],
  gas: ['amenity=fuel'],
  fuel: ['amenity=fuel'],
  gasstation: ['amenity=fuel'],
  bank: ['amenity=bank'],
  atm: ['amenity=atm'],
  pharmacy: ['amenity=pharmacy'],
  drugstore: ['amenity=pharmacy'],
  hospital: ['amenity=hospital'],
  supermarket: ['shop=supermarket', 'shop=grocery'],
  grocery: ['shop=supermarket', 'shop=grocery'],
  bar: ['amenity=bar'],
  gym: ['leisure=fitness_centre'],
  hotel: ['tourism=hotel'],
  parking: ['amenity=parking'],
  park: ['leisure=park'],
  school: ['amenity=school']
};

function nearbyTagFilter(query) {
  const q = String(query || '').toLowerCase();
  const keywords = Object.keys(NEARBY_TAG_MAP);
  for (const kw of keywords) {
    if (q.includes(kw)) return NEARBY_TAG_MAP[kw];
  }
  return null;
}

function haversineMi(lat1, lon1, lat2, lon2) {
  const R = 3958.8; // Earth radius in miles
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// A 2km search radius was too tight for anything outside a dense downtown
// core — sparser categories (a specific chain, a school) routinely had zero
// tagged results that close. 10 miles gives Overpass a realistic suburban
// search area while findNearbyPlaces still only returns the closest 5.
const NEARBY_RADIUS_MI = 10;

// Builds a bounding box of +/- NEARBY_RADIUS_MI around (lat, lon) as
// Overpass's (south,west,north,east).
function overpassBbox(lat, lon) {
  const radiusKm = NEARBY_RADIUS_MI * 1.60934;
  const dLat = radiusKm / 111;
  const dLon = radiusKm / (111 * Math.cos(lat * Math.PI / 180));
  return `${lat - dLat},${lon - dLon},${lat + dLat},${lon + dLon}`;
}

// Short human address from OSM addr:* tags.
function osmAddress(tags = {}) {
  const parts = [];
  if (tags['addr:housenumber']) parts.push(tags['addr:housenumber']);
  if (tags['addr:street']) parts.push(tags['addr:street']);
  if (parts.length === 0 && tags['addr:city']) parts.push(tags['addr:city']);
  return parts.join(' ');
}

function registerMapsIpc() {
  ipcMain.handle('maps:find-nearby', async (event, { lat, lon, query }) => {
    const bbox = overpassBbox(Number(lat), Number(lon));
    const tags = nearbyTagFilter(query);
    let nodeFilter;
    if (tags) {
      nodeFilter = '(' + tags.map((t) => `node[${t}](${bbox})`).join(';\n') + ';' +
        tags.map((t) => `way[${t}](${bbox})`).join(';\n') + ';)';
    } else {
      // Chain names are often tagged in OSM with different punctuation than
      // a spoken query gives (e.g. "Baskin-Robbins" vs. the query "Baskin
      // Robbins") — a literal-space regex match on the raw query text
      // silently misses a real match sitting right there. Escape each word
      // for regex safety, then join with an optional hyphen/space so
      // punctuation differences between words don't matter.
      const words = String(query).trim().split(/\s+/).filter(Boolean);
      const namePattern = words
        .map((w) => w.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&'))
        .join('[- ]?');
      const escaped = namePattern.replace(/"/g, '\\"');
      nodeFilter = `(node["name"~"${escaped}",i](${bbox});way["name"~"${escaped}",i](${bbox});)`;
    }
    // Overpass's `out` cap truncates in arbitrary/index order, not
    // nearest-first, so a wide 10-mile box needs a generous cap or the
    // actual closest match can get cut before findNearbyPlaces ever sorts
    // by distance and slices to the top 5.
    const overpassQl = `[out:json][timeout:15];\n${nodeFilter};\nout center 100;`;
    const data = await httpsPostJson('https://overpass-api.de/api/interpreter', overpassQl, { 'User-Agent': 'jarvis-voice-ai/1.0' });

    const elements = (data.elements || []).map((el) => {
      const elLat = el.lat ?? el.center?.lat;
      const elLon = el.lon ?? el.center?.lon;
      return {
        name: el.tags?.name || el.tags?.[tags?.[0]?.split('=')[0] || 'amenity'] || 'Unnamed place',
        lat: elLat,
        lon: elLon,
        address: osmAddress(el.tags),
        tags: el.tags || {}
      };
    }).filter((p) => p.name && typeof p.lat === 'number');

    const places = elements
      .map((p) => ({ ...p, distanceMi: haversineMi(Number(lat), Number(lon), p.lat, p.lon) }))
      .sort((a, b) => a.distanceMi - b.distanceMi)
      .slice(0, 5)
      .map((p) => ({ name: p.name, distanceMi: p.distanceMi, address: p.address }));

    return { success: true, places };
  });

  ipcMain.handle('maps:get-directions', async (event, { lat, lon, destinationQuery }) => {
    // Bias the geocode search around the user so "the airport" resolves
    // locally, not to a same-named place on the other side of the world.
    const dLat = 10 / 111;
    const dLon = 10 / (111 * Math.cos(Number(lat) * Math.PI / 180));
    const viewbox = `${lon - dLon},${lat + dLat},${lon + dLon},${lat - dLat}`;
    const geocodeUrl = 'https://nominatim.openstreetmap.org/search?' + new URLSearchParams({
      q: destinationQuery,
      format: 'jsonv2',
      limit: '1',
      viewbox,
      bounded: '1'
    }).toString();

    const geocode = await httpsGetJson(geocodeUrl, { 'User-Agent': 'jarvis-voice-ai/1.0' });
    const top = Array.isArray(geocode) ? geocode[0] : null;
    if (!top || top.lat == null || top.lon == null) {
      return { success: false, message: "I couldn't find that place, Sir." };
    }

    const osrmUrl =
      `https://router.project-osrm.org/route/v1/driving/${Number(lon)},${Number(lat)};${Number(top.lon)},${Number(top.lat)}?overview=false`;
    const route = await httpsGetJson(osrmUrl);
    const leg = route?.routes?.[0];
    if (!leg || leg.distance == null) {
      return { success: false, message: "I couldn't find a route to that place, Sir." };
    }

    return {
      success: true,
      distanceMi: Math.round(leg.distance / 1609.344 * 10) / 10,
      durationMin: Math.round(leg.duration / 60),
      destinationLabel: top.display_name || String(destinationQuery)
    };
  });
}

// --- JARVIS notes filesystem (sandboxed .md scratchpad) ------------------
// A small private notes directory under userData (same convention as the
// spotify/google token .bin files). JARVIS uses these as its own organic
// memory mid-conversation; everything is confined to this directory, flat,
// .md only. See
// docs/superpowers/specs/2026-08-19-jarvis-notes-filesystem-design.md.
const NOTES_DIR = path.join(app.getPath('userData'), 'jarvis-notes');
const MAX_NOTE_BYTES = 100 * 1024;
const MAX_NOTE_COUNT = 200;

function ensureNotesDir() {
  if (!fs.existsSync(NOTES_DIR)) fs.mkdirSync(NOTES_DIR, { recursive: true });
}

// The real trust boundary for note filenames. Runs in the main process
// regardless of what the renderer/LLM passed in — the model's suggested
// filename is never trusted as a real path. Lowercases, collapses
// whitespace to '-', strips everything outside [a-z0-9-_], forces a .md
// extension, and rejects (throws) if the raw input contained '..', '/' or
// '\' or sanitizes to empty. Reserved Windows device names (con, nul, ...)
// are left alone — they're just data filenames under our own dir, never
// opened as devices.
function sanitizeFilename(name) {
  let raw = String(name || '');
  if (raw.includes('..') || raw.includes('/') || raw.includes('\\')) {
    throw new Error('invalid filename: path traversal');
  }
  // Strip one pre-existing .md so re-saving a listed name
  // ('wifi-password.md') stays 'wifi-password.md' instead of corrupting
  // into 'wifi-passwordmd.md'. Runs before the character filter below.
  if (raw.toLowerCase().endsWith('.md')) raw = raw.slice(0, -3);
  const base = raw
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_-]/g, '')
    .replace(/\.+$/, '');
  if (!base) throw new Error('invalid filename: empty after sanitization');
  return `${base}.md`;
}

// First ~60 chars of the first non-empty line, whitespace-collapsed, used as
// a list preview.
function previewNote(content) {
  const firstLine = String(content || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean) || '';
  const collapsed = firstLine.replace(/\s+/g, ' ').trim();
  return collapsed.length > 60 ? collapsed.slice(0, 60) + '…' : collapsed;
}

function registerFilesIpc() {
  ipcMain.handle('files:write', (event, { filename, content, overwrite }) => {
    let safe;
    try {
      safe = sanitizeFilename(filename);
    } catch (e) {
      console.warn('[files] rejected filename:', filename);
      return { success: false, message: "That isn't a usable note name, Sir." };
    }

    if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_NOTE_BYTES) {
      return { success: false, message: 'That note is too long to save, Sir.' };
    }

    ensureNotesDir();
    const filePath = path.join(NOTES_DIR, safe);
    const exists = fs.existsSync(filePath);

    // Existing file + not explicitly overwriting -> report back so the
    // renderer can route through the spoken-confirmation flow; nothing is
    // written here.
    if (exists && !overwrite) {
      return { success: false, exists: true, filename: safe };
    }

    // Only new files count against the note-count cap (an overwrite replaces
    // in place and doesn't grow the directory).
    if (!exists) {
      try {
        const count = fs.readdirSync(NOTES_DIR).filter((f) => f.endsWith('.md')).length;
        if (count >= MAX_NOTE_COUNT) {
          return { success: false, message: 'Your notes sandbox is full, Sir — delete an old note first.' };
        }
      } catch (e) {
        console.warn('[files] count check failed:', e.message);
      }
    }

    try {
      fs.writeFileSync(filePath, content, 'utf8');
      return { success: true, filename: safe };
    } catch (e) {
      console.warn('[files] write failed:', e.message);
      return { success: false, message: "I wasn't able to save that note, Sir." };
    }
  });

  ipcMain.handle('files:read', (event, { filename }) => {
    let safe;
    try {
      safe = sanitizeFilename(filename);
    } catch (e) {
      return { success: false, message: "That isn't a usable note name, Sir." };
    }
    const filePath = path.join(NOTES_DIR, safe);
    if (!fs.existsSync(filePath)) {
      return { success: false, message: "No note by that name, Sir." };
    }
    try {
      return { success: true, content: fs.readFileSync(filePath, 'utf8') };
    } catch (e) {
      console.warn('[files] read failed:', e.message);
      return { success: false, message: "I wasn't able to read that note, Sir." };
    }
  });

  ipcMain.handle('files:list', () => {
    ensureNotesDir();
    try {
      const files = fs.readdirSync(NOTES_DIR)
        .filter((f) => f.endsWith('.md'))
        .map((f) => {
          const filePath = path.join(NOTES_DIR, f);
          let modifiedAt = 0;
          let preview = '';
          try {
            const stat = fs.statSync(filePath);
            modifiedAt = stat.mtimeMs;
          } catch (e) {}
          try {
            preview = previewNote(fs.readFileSync(filePath, 'utf8'));
          } catch (e) {}
          return { filename: f, preview, modifiedAt };
        })
        .sort((a, b) => b.modifiedAt - a.modifiedAt);
      return { success: true, files };
    } catch (e) {
      console.warn('[files] list failed:', e.message);
      return { success: false, message: "I wasn't able to list your notes, Sir." };
    }
  });

  ipcMain.handle('files:delete', (event, { filename }) => {
    let safe;
    try {
      safe = sanitizeFilename(filename);
    } catch (e) {
      return { success: false, message: "That isn't a usable note name, Sir." };
    }
    const filePath = path.join(NOTES_DIR, safe);
    if (!fs.existsSync(filePath)) {
      return { success: false, message: "No note by that name, Sir." };
    }
    try {
      fs.unlinkSync(filePath);
      return { success: true };
    } catch (e) {
      console.warn('[files] delete failed:', e.message);
      return { success: false, message: "I wasn't able to delete that note, Sir." };
    }
  });
}

function registerWolframIpc() {
  // Same plain-Node-HTTPS-in-main-process trick as registerSteamIpc, to avoid
  // browser CORS entirely for the packaged app.
  ipcMain.handle('wolfram:solve', (event, { appId, query }) => {
    const url = `https://api.wolframalpha.com/v1/spoken?appid=${encodeURIComponent(appId)}&i=${encodeURIComponent(query)}`;
    return new Promise((resolve, reject) => {
      https.get(url, (res) => {
        let data = '';
        res.on('data', (chunkData) => { data += chunkData; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data);
          } else if (res.statusCode === 501) {
            // WolframAlpha's documented response code for "no spoken result
            // available for this query" — not an error, just no answer.
            resolve(null);
          } else {
            reject(new Error(`WolframAlpha API HTTP ${res.statusCode}`));
          }
        });
      }).on('error', reject);
    });
  });
}

function registerSpotifyIpc() {
  // Client Credentials token exchange requires POSTing a client secret —
  // this must stay in the main process rather than going through the public
  // CORS proxy Steam/Wolfram use in a plain browser tab, since that proxy is
  // fine for a public app ID but not for a real secret.
  ipcMain.handle('spotify:resolve-track', (event, { clientId, clientSecret, query }) => {
    return new Promise((resolve, reject) => {
      const tokenBody = 'grant_type=client_credentials';
      const authHeader = 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

      const tokenReq = https.request('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(tokenBody)
        }
      }, (tokenRes) => {
        let tokenData = '';
        tokenRes.on('data', (chunk) => { tokenData += chunk; });
        tokenRes.on('end', () => {
          if (tokenRes.statusCode !== 200) {
            reject(new Error(`Spotify token HTTP ${tokenRes.statusCode}`));
            return;
          }

          let accessToken;
          try {
            accessToken = JSON.parse(tokenData).access_token;
          } catch (e) {
            reject(new Error('Invalid Spotify token response'));
            return;
          }

          const searchUrl = `https://api.spotify.com/v1/search?type=track&limit=1&q=${encodeURIComponent(query)}`;
          https.get(searchUrl, { headers: { Authorization: `Bearer ${accessToken}` } }, (searchRes) => {
            let searchData = '';
            searchRes.on('data', (chunk) => { searchData += chunk; });
            searchRes.on('end', () => {
              if (searchRes.statusCode !== 200) {
                reject(new Error(`Spotify search HTTP ${searchRes.statusCode}`));
                return;
              }

              try {
                const parsed = JSON.parse(searchData);
                const track = parsed.tracks?.items?.[0];
                resolve(track ? {
                  uri: track.uri,
                  name: track.name,
                  artist: track.artists?.[0]?.name || ''
                } : null);
              } catch (e) {
                reject(new Error('Invalid Spotify search response'));
              }
            });
          }).on('error', reject);
        });
      });

      tokenReq.on('error', reject);
      tokenReq.write(tokenBody);
      tokenReq.end();
    });
  });
}

// --- Spotify account connection (Authorization Code OAuth) ---------------
// Gives JARVIS read access to the user's own playlists and saved albums —
// something the Client Credentials flow above can never see, since that
// flow only authenticates the app itself, not a specific Spotify user.
// Tokens are encrypted at rest via Electron's safeStorage (OS keychain/DPAPI
// on Windows — no extra dependency needed).
function spotifyTokensPath() {
  return path.join(app.getPath('userData'), 'spotify-tokens.bin');
}

function loadSpotifyTokens() {
  try {
    const tokenPath = spotifyTokensPath();
    if (!fs.existsSync(tokenPath) || !safeStorage.isEncryptionAvailable()) return null;
    const decrypted = safeStorage.decryptString(fs.readFileSync(tokenPath));
    return JSON.parse(decrypted);
  } catch (e) {
    return null;
  }
}

function saveSpotifyTokens(tokens) {
  if (!safeStorage.isEncryptionAvailable()) return false;
  fs.writeFileSync(spotifyTokensPath(), safeStorage.encryptString(JSON.stringify(tokens)));
  return true;
}

function clearSpotifyTokens() {
  try {
    const tokenPath = spotifyTokensPath();
    if (fs.existsSync(tokenPath)) fs.unlinkSync(tokenPath);
  } catch (e) {}
}

function spotifyTokenRequest(clientId, clientSecret, bodyParams) {
  const body = new URLSearchParams(bodyParams).toString();
  const authHeader = 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  return new Promise((resolve, reject) => {
    const req = https.request('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`Spotify token exchange HTTP ${res.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Invalid Spotify token response'));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function getValidSpotifyAccessToken(clientId, clientSecret) {
  const tokens = loadSpotifyTokens();
  if (!tokens || !tokens.refresh_token) return null;

  // 60s safety margin before actual expiry.
  if (tokens.access_token && tokens.expires_at && Date.now() < tokens.expires_at - 60000) {
    return tokens.access_token;
  }

  const refreshed = await spotifyTokenRequest(clientId, clientSecret, {
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token
  });

  const updated = {
    access_token: refreshed.access_token,
    refresh_token: refreshed.refresh_token || tokens.refresh_token,
    expires_at: Date.now() + refreshed.expires_in * 1000
  };
  saveSpotifyTokens(updated);
  return updated.access_token;
}

function spotifyApiGet(url, accessToken) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { Authorization: `Bearer ${accessToken}` } }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          // Surface Spotify's actual error body (usually
          // {"error":{"status":...,"message":"..."}}) instead of a bare
          // status code — a 403 here can mean several different things
          // (missing scope, dashboard user-access restriction, revoked
          // token) and the message says which.
          let reason = data;
          try { reason = JSON.parse(data)?.error?.message || data; } catch (e) {}
          reject(new Error(`Spotify API HTTP ${res.statusCode} on ${url.replace(/^https:\/\/api\.spotify\.com\/v1\//, '')}: ${reason}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Invalid Spotify API response'));
        }
      });
    }).on('error', reject);
  });
}

async function fetchAllSpotifyPages(firstUrl, accessToken) {
  let items = [];
  let next = firstUrl;
  while (next) {
    const page = await spotifyApiGet(next, accessToken);
    items = items.concat(page.items || []);
    next = page.next;
  }
  return items;
}

function registerSpotifyAuthIpc() {
  ipcMain.handle('spotify:auth-status', () => {
    const tokens = loadSpotifyTokens();
    return { authenticated: !!(tokens && tokens.refresh_token) };
  });

  ipcMain.handle('spotify:logout', () => {
    clearSpotifyTokens();
    return { success: true };
  });

  // Opens the system browser for the user to approve access, catches the
  // redirect on a local loopback HTTP server (the standard desktop-app OAuth
  // pattern), then exchanges the code for tokens in the main process so the
  // client secret never touches the renderer or a third-party proxy.
  ipcMain.handle('spotify:authorize', (event, { clientId, clientSecret }) => {
    if (!clientId || !clientSecret) {
      return Promise.reject(new Error('Spotify Client ID and Secret are required to connect your account.'));
    }

    return new Promise((resolve, reject) => {
      const state = crypto.randomBytes(16).toString('hex');
      let settled = false;
      let server;

      const finish = (fn, arg) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        try { server.close(); } catch (e) {}
        fn(arg);
      };

      const timeout = setTimeout(() => {
        finish(reject, new Error('Spotify login timed out. Please try again.'));
      }, 120000);

      server = http.createServer((req, res) => {
        const reqUrl = new URL(req.url, `http://127.0.0.1:${SPOTIFY_REDIRECT_PORT}`);
        if (reqUrl.pathname !== '/callback') {
          res.writeHead(404);
          res.end();
          return;
        }

        const code = reqUrl.searchParams.get('code');
        const returnedState = reqUrl.searchParams.get('state');
        const authError = reqUrl.searchParams.get('error');
        const ok = !authError && code && returnedState === state;

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(
          `<html><body style="font-family:sans-serif;background:#05070c;color:${ok ? '#39ff14' : '#ff3b3b'};text-align:center;padding-top:80px">` +
          `<h2>ARIA: Spotify ${ok ? 'connected' : 'connection failed'}.</h2>` +
          `<p style="color:#8899aa">You can close this tab and return to ARIA.</p></body></html>`
        );

        if (!ok) {
          finish(reject, new Error(authError ? `Spotify authorization denied: ${authError}` : 'Invalid Spotify authorization response.'));
          return;
        }

        spotifyTokenRequest(clientId, clientSecret, {
          grant_type: 'authorization_code',
          code,
          redirect_uri: SPOTIFY_REDIRECT_URI
        }).then((tokenResp) => {
          if (!tokenResp.refresh_token) {
            finish(reject, new Error('Spotify did not return a refresh token. Disconnect ARIA from your Spotify account and try again.'));
            return;
          }
          const saved = saveSpotifyTokens({
            access_token: tokenResp.access_token,
            refresh_token: tokenResp.refresh_token,
            expires_at: Date.now() + tokenResp.expires_in * 1000
          });
          if (!saved) {
            // Don't report success when tokens were never persisted — the UI
            // would show "Connected" and every later call would fail.
            finish(reject, new Error('Could not securely store Spotify credentials: OS secure storage is unavailable.'));
            return;
          }
          finish(resolve, { success: true });
        }).catch((err) => finish(reject, err));
      });

      server.on('error', (err) => {
        finish(reject, new Error(`Could not start local Spotify login server: ${err.message}`));
      });

      server.listen(SPOTIFY_REDIRECT_PORT, '127.0.0.1', () => {
        const authUrl = 'https://accounts.spotify.com/authorize?' + new URLSearchParams({
          client_id: clientId,
          response_type: 'code',
          redirect_uri: SPOTIFY_REDIRECT_URI,
          scope: SPOTIFY_AUTH_SCOPES,
          state
        }).toString();
        shell.openExternal(authUrl);
      });
    });
  });

  ipcMain.handle('spotify:get-library', async (event, { clientId, clientSecret }) => {
    const accessToken = await getValidSpotifyAccessToken(clientId, clientSecret);
    if (!accessToken) {
      throw new Error('Not connected to Spotify. Please connect your account first.');
    }

    const [playlistItems, albumItems] = await Promise.all([
      fetchAllSpotifyPages('https://api.spotify.com/v1/me/playlists?limit=50', accessToken),
      fetchAllSpotifyPages('https://api.spotify.com/v1/me/albums?limit=50', accessToken)
    ]);

    return {
      playlists: playlistItems
        .filter((p) => p && p.id)
        .map((p) => ({ id: p.id, name: p.name, uri: p.uri, owner: p.owner?.display_name || '' })),
      albums: albumItems
        .filter((entry) => entry && entry.album)
        .map((entry) => ({
          id: entry.album.id,
          name: entry.album.name,
          uri: entry.album.uri,
          artist: entry.album.artists?.[0]?.name || ''
        }))
    };
  });
}

// --- Google account connection (Authorization Code + PKCE OAuth) ---------
// Gives JARVIS read access to the user's own Gmail — see
// docs/superpowers/specs/2026-08-15-gmail-google-connector-design.md.
// Tokens are encrypted at rest via Electron's safeStorage, same as Spotify.
function googleTokensPath() {
  return path.join(app.getPath('userData'), 'google-tokens.bin');
}

function loadGoogleTokens() {
  try {
    const tokenPath = googleTokensPath();
    if (!fs.existsSync(tokenPath) || !safeStorage.isEncryptionAvailable()) return null;
    const decrypted = safeStorage.decryptString(fs.readFileSync(tokenPath));
    return JSON.parse(decrypted);
  } catch (e) {
    return null;
  }
}

function saveGoogleTokens(tokens) {
  if (!safeStorage.isEncryptionAvailable()) return false;
  fs.writeFileSync(googleTokensPath(), safeStorage.encryptString(JSON.stringify(tokens)));
  return true;
}

function clearGoogleTokens() {
  try {
    const tokenPath = googleTokensPath();
    if (fs.existsSync(tokenPath)) fs.unlinkSync(tokenPath);
  } catch (e) {}
}

// Google's token endpoint takes client_id/client_secret as plain POST body
// fields (unlike Spotify's HTTP Basic auth header).
function googleTokenRequest(bodyParams) {
  const body = new URLSearchParams(bodyParams).toString();

  return new Promise((resolve, reject) => {
    const req = https.request('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch (e) {
          reject(new Error('Invalid Google token response'));
          return;
        }
        if (res.statusCode !== 200) {
          const { message, revoked } = describeGoogleTokenError(res.statusCode, parsed);
          const err = new Error(message);
          err.revoked = revoked;
          reject(err);
          return;
        }
        resolve(parsed);
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function getValidGoogleAccessToken(clientId, clientSecret) {
  const tokens = loadGoogleTokens();
  if (!tokens || !tokens.refresh_token) return null;

  if (tokens.access_token && tokens.expires_at && Date.now() < tokens.expires_at - 60000) {
    return tokens.access_token;
  }

  let refreshed;
  try {
    refreshed = await googleTokenRequest({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: clientId,
      client_secret: clientSecret
    });
  } catch (err) {
    // A dead refresh token never recovers — drop it so the app reports
    // "not connected" instead of failing the same way on every call.
    if (err.revoked) clearGoogleTokens();
    throw err;
  }

  const updated = {
    access_token: refreshed.access_token,
    refresh_token: tokens.refresh_token, // Google does not re-issue this on refresh
    expires_at: Date.now() + refreshed.expires_in * 1000
  };
  saveGoogleTokens(updated);
  return updated.access_token;
}

function gmailApiGet(url, accessToken) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { Authorization: `Bearer ${accessToken}` } }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          let reason = data;
          try { reason = JSON.parse(data)?.error?.message || data; } catch (e) {}
          reject(new Error(`Gmail API HTTP ${res.statusCode}: ${reason}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Invalid Gmail API response'));
        }
      });
    }).on('error', reject);
  });
}

function extractGmailHeader(headers, name) {
  const found = (headers || []).find((h) => h.name.toLowerCase() === name.toLowerCase());
  return found ? found.value : '';
}

async function fetchGmailMessageSummary(id, accessToken) {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`;
  const data = await gmailApiGet(url, accessToken);
  const headers = data.payload?.headers || [];
  return {
    id: data.id,
    from: extractGmailHeader(headers, 'From'),
    subject: extractGmailHeader(headers, 'Subject'),
    date: extractGmailHeader(headers, 'Date'),
    snippet: data.snippet || ''
  };
}

async function listGmailMessages(accessToken, { q, maxResults = 10 } = {}) {
  const params = new URLSearchParams({ maxResults: String(maxResults) });
  if (q) params.set('q', q);
  const listData = await gmailApiGet(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${params.toString()}`, accessToken);
  const ids = (listData.messages || []).map((m) => m.id);
  return Promise.all(ids.map((id) => fetchGmailMessageSummary(id, accessToken)));
}

// --- Google Calendar API helpers -----------------------------------------
// gmailApiGet is generic enough to serve Calendar's authenticated GETs too —
// deliberately not renamed to avoid an unrelated refactor (the harness calls
// the same endpoint shape either way).

// Lists upcoming events on the primary calendar starting from now, ordered by
// start time, with recurring events expanded to individual instances
// (singleEvents=true). The optional `q` is the Calendar API's own server-side
// full-text search — same "let the server search" pattern as Gmail.
function listCalendarEvents(accessToken, { q, maxResults = 10 } = {}) {
  const params = new URLSearchParams({
    maxResults: String(maxResults),
    singleEvents: 'true',
    orderBy: 'startTime',
    timeMin: new Date().toISOString()
  });
  if (q) params.set('q', q);
  return gmailApiGet(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params.toString()}`, accessToken)
    .then((data) => (data.items || []).map((event) => ({
      id: event.id,
      title: event.summary || '(no title)',
      start: event.start?.dateTime || event.start?.date,
      end: event.end?.dateTime || event.end?.date,
      description: event.description || ''
    })));
}

// Generic authenticated POST helper — mirrors gmailApiGet's shape (bearer
// token, JSON body, expects a 200 response) for Calendar event creation.
function googleApiPost(url, accessToken, bodyObj) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(bodyObj);
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          let reason = data;
          try { reason = JSON.parse(data)?.error?.message || data; } catch (e) {}
          reject(new Error(`Google API HTTP ${res.statusCode}: ${reason}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Invalid Google API response'));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Creates a single event on the primary calendar. startISO/endISO are always
// already-resolved ISO timestamps — the renderer harness owns any
// natural-language date parsing via chrono-node, the main process never sees
// raw phrases like "tomorrow at 3pm".
async function createCalendarEvent(accessToken, { title, description, startISO, endISO }) {
  const data = await googleApiPost('https://www.googleapis.com/calendar/v3/calendars/primary/events', accessToken, {
    summary: title,
    description,
    start: { dateTime: startISO },
    end: { dateTime: endISO }
  });
  return {
    id: data.id,
    title: data.summary || title,
    start: data.start?.dateTime || data.start?.date,
    end: data.end?.dateTime || data.end?.date
  };
}

function decodeGmailBase64Url(data) {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
}

// Recursively finds the first text/plain part in a (possibly multipart)
// Gmail message payload; falls back to a stripped text/html part if no
// plain-text part exists.
function findGmailPlainTextPart(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) return decodeGmailBase64Url(payload.body.data);
  if (payload.parts) {
    for (const part of payload.parts) {
      const found = findGmailPlainTextPart(part);
      if (found) return found;
    }
  }
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    return decodeGmailBase64Url(payload.body.data).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  return '';
}

async function fetchGmailFullMessage(id, accessToken) {
  const data = await gmailApiGet(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`, accessToken);
  const headers = data.payload?.headers || [];
  const body = findGmailPlainTextPart(data.payload) || data.snippet || '';
  return {
    id: data.id,
    from: extractGmailHeader(headers, 'From'),
    subject: extractGmailHeader(headers, 'Subject'),
    date: extractGmailHeader(headers, 'Date'),
    // Truncated so a long email doesn't get read back verbatim word-for-word.
    body: body.length > 2000 ? body.slice(0, 2000) + '…' : body
  };
}

function registerGoogleAuthIpc() {
  ipcMain.handle('google:auth-status', () => {
    const tokens = loadGoogleTokens();
    return { authenticated: !!(tokens && tokens.refresh_token) };
  });

  ipcMain.handle('google:logout', () => {
    clearGoogleTokens();
    return { success: true };
  });

  // Authorization Code + PKCE flow via a local loopback HTTP server, same
  // pattern as Spotify above. access_type=offline + prompt=consent guarantee
  // a refresh_token comes back (Google only issues one on first consent
  // otherwise). code_verifier/code_challenge are PKCE — Google's Desktop-app
  // OAuth clients get a client_secret too, but Google's own docs note it
  // isn't a true secret for installed apps, so PKCE is the real protection.
  ipcMain.handle('google:authorize', (event, { clientId, clientSecret }) => {
    if (!clientId || !clientSecret) {
      return Promise.reject(new Error('Google Client ID and Secret are required to connect your account.'));
    }

    return new Promise((resolve, reject) => {
      const state = crypto.randomBytes(16).toString('hex');
      const codeVerifier = crypto.randomBytes(32).toString('base64url');
      const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
      let settled = false;
      let server;

      const finish = (fn, arg) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        try { server.close(); } catch (e) {}
        fn(arg);
      };

      const timeout = setTimeout(() => {
        finish(reject, new Error('Google login timed out. Please try again.'));
      }, 120000);

      server = http.createServer((req, res) => {
        const reqUrl = new URL(req.url, `http://127.0.0.1:${GOOGLE_REDIRECT_PORT}`);
        if (reqUrl.pathname !== '/callback') {
          res.writeHead(404);
          res.end();
          return;
        }

        const code = reqUrl.searchParams.get('code');
        const returnedState = reqUrl.searchParams.get('state');
        const authError = reqUrl.searchParams.get('error');
        const ok = !authError && code && returnedState === state;

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(
          `<html><body style="font-family:sans-serif;background:#05070c;color:${ok ? '#39ff14' : '#ff3b3b'};text-align:center;padding-top:80px">` +
          `<h2>ARIA: Google account ${ok ? 'connected' : 'connection failed'}.</h2>` +
          `<p style="color:#8899aa">You can close this tab and return to ARIA.</p></body></html>`
        );

        if (!ok) {
          finish(reject, new Error(authError ? `Google authorization denied: ${authError}` : 'Invalid Google authorization response.'));
          return;
        }

        googleTokenRequest({
          grant_type: 'authorization_code',
          code,
          redirect_uri: GOOGLE_REDIRECT_URI,
          client_id: clientId,
          client_secret: clientSecret,
          code_verifier: codeVerifier
        }).then((tokenResp) => {
          if (!tokenResp.refresh_token) {
            finish(reject, new Error("Google did not return a refresh token. Remove ARIA from your Google Account's connected apps and try again."));
            return;
          }
          if (!saveGoogleTokens({
            access_token: tokenResp.access_token,
            refresh_token: tokenResp.refresh_token,
            expires_at: Date.now() + tokenResp.expires_in * 1000
          })) {
            // Don't report success when tokens were never persisted — the UI
            // would show "Connected" and every later call would fail.
            finish(reject, new Error('Could not securely store Google credentials: OS secure storage is unavailable.'));
            return;
          }
          finish(resolve, { success: true });
        }).catch((err) => finish(reject, err));
      });

      server.on('error', (err) => {
        finish(reject, new Error(`Could not start local Google login server: ${err.message}`));
      });

      server.listen(GOOGLE_REDIRECT_PORT, '127.0.0.1', () => {
        const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
          client_id: clientId,
          response_type: 'code',
          redirect_uri: GOOGLE_REDIRECT_URI,
          scope: GOOGLE_AUTH_SCOPES,
          access_type: 'offline',
          prompt: 'consent',
          code_challenge: codeChallenge,
          code_challenge_method: 'S256',
          state
        }).toString();
        shell.openExternal(authUrl);
      });
    });
  });

  ipcMain.handle('gmail:list-messages', async (event, { clientId, clientSecret, maxResults }) => {
    const accessToken = await getValidGoogleAccessToken(clientId, clientSecret);
    if (!accessToken) throw new Error('Not connected to Google. Please connect your account first.');
    return listGmailMessages(accessToken, { maxResults });
  });

  ipcMain.handle('gmail:search-messages', async (event, { clientId, clientSecret, query, maxResults }) => {
    const accessToken = await getValidGoogleAccessToken(clientId, clientSecret);
    if (!accessToken) throw new Error('Not connected to Google. Please connect your account first.');
    return listGmailMessages(accessToken, { q: query, maxResults });
  });

  ipcMain.handle('gmail:get-message', async (event, { clientId, clientSecret, id }) => {
    const accessToken = await getValidGoogleAccessToken(clientId, clientSecret);
    if (!accessToken) throw new Error('Not connected to Google. Please connect your account first.');
    return fetchGmailFullMessage(id, accessToken);
  });

  ipcMain.handle('calendar:list-events', async (event, { clientId, clientSecret, maxResults }) => {
    const accessToken = await getValidGoogleAccessToken(clientId, clientSecret);
    if (!accessToken) throw new Error('Not connected to Google. Please connect your account first.');
    return listCalendarEvents(accessToken, { maxResults });
  });

  ipcMain.handle('calendar:search-events', async (event, { clientId, clientSecret, query, maxResults }) => {
    const accessToken = await getValidGoogleAccessToken(clientId, clientSecret);
    if (!accessToken) throw new Error('Not connected to Google. Please connect your account first.');
    return listCalendarEvents(accessToken, { q: query, maxResults });
  });

  ipcMain.handle('calendar:create-event', async (event, { clientId, clientSecret, title, description, startISO, endISO }) => {
    const accessToken = await getValidGoogleAccessToken(clientId, clientSecret);
    if (!accessToken) throw new Error('Not connected to Google. Please connect your account first.');
    return createCalendarEvent(accessToken, { title, description, startISO, endISO });
  });
}

function registerMcpIpc() {
  ipcMain.handle('mcp:fetch-webpage', async (event, { url }) => {
    return mcpManager.fetchWebpageText(url);
  });

  ipcMain.handle('mcp:browse-webpage', async (event, { url, linkText }) => {
    return mcpManager.browseAndExtract(url, linkText);
  });
}

function sendUpdateState(state) {
  lastUpdateState = state;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update:state', state);
}

function registerUpdaterEvents() {
  autoUpdater.on('checking-for-update', () => {
    sendUpdateState({ status: 'checking' });
  });

  autoUpdater.on('update-available', (info) => {
    const classification = classifyUpdate(app.getVersion(), info.version);
    pendingUpdate = { version: info.version, classification };

    if (classification === 'major') {
      // Major bumps auto-download silently — no click needed until install.
      sendUpdateState({ status: 'downloading', version: info.version, classification, progress: 0 });
      autoUpdater.downloadUpdate();
    } else {
      // Minor/patch bumps surface passively; download waits for update:download.
      sendUpdateState({ status: 'available', version: info.version, classification });
    }
  });

  autoUpdater.on('update-not-available', () => {
    pendingUpdate = null;
    sendUpdateState({ status: 'idle' });
  });

  autoUpdater.on('download-progress', (progress) => {
    sendUpdateState({
      status: 'downloading',
      version: pendingUpdate?.version,
      classification: pendingUpdate?.classification,
      progress: Math.round(progress.percent)
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    updateReadyToInstall = true;
    sendUpdateState({ status: 'ready', version: info.version, classification: pendingUpdate?.classification });
  });

  autoUpdater.on('error', (err) => {
    // A failed silent launch check shouldn't alarm the user — it just logs
    // to the terminal panel via the renderer's console-message bridge and
    // leaves the UI at whatever state it was already in (usually 'idle').
    console.warn('[autoUpdater]', err?.message || err);
    sendUpdateState({ status: 'error', message: err?.message || 'Update check failed' });
  });
}

function registerUpdateIpc() {
  ipcMain.handle('update:get-version', () => app.getVersion());

  // Snapshot of the last autoUpdater state — lets the renderer replay events
  // that fired before it subscribed (e.g. the silent launch-time check).
  ipcMain.handle('update:get-state', () => lastUpdateState);

  ipcMain.handle('update:check', () => {
    if (!app.isPackaged) {
      // Dev builds have no publish feed to compare against — report idle
      // instead of letting electron-updater throw on a missing app-update.yml.
      sendUpdateState({ status: 'idle' });
      return;
    }
    autoUpdater.checkForUpdates().catch(() => {});
  });

  ipcMain.handle('update:download', () => {
    if (pendingUpdate) autoUpdater.downloadUpdate();
  });

  ipcMain.handle('update:install', () => {
    if (updateReadyToInstall) autoUpdater.quitAndInstall();
  });

  // Public GitHub Releases list — no auth needed for a public repo, just a
  // User-Agent header (GitHub rejects requests without one). Same plain
  // Node HTTPS pattern as registerSteamIpc, run in the main process to avoid
  // renderer CORS.
  ipcMain.handle('update:get-changelog', () => {
    const options = {
      hostname: 'api.github.com',
      path: '/repos/avanishbadhan/ARIA/releases?per_page=10',
      headers: { 'User-Agent': 'jarvis-voice-ai' }
    };
    return new Promise((resolve) => {
      https.get(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            resolve([]);
            return;
          }
          try {
            const releases = JSON.parse(data);
            resolve(releases.map((r) => ({ version: r.tag_name, notes: r.body || '' })));
          } catch (e) {
            resolve([]);
          }
        });
      }).on('error', () => resolve([]));
    });
  });
}

app.whenReady().then(() => {
  // Grant microphone access automatically — this is a trusted first-party app,
  // and the voice pipeline is core functionality, not an optional feature.
  // Also auto-approve geolocation: by default Electron silently denies
  // permission requests with no handler registered (no native OS prompt
  // appears, `getCurrentPosition` just errors), so without this the Location
  // panel would never resolve a position.
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(permission === 'media' || permission === 'geolocation');
  });

  registerSteamIpc();
  registerGameLibraryIpc();
  registerMicIpc();
  registerScreenCaptureIpc();
  registerScreenMonitorIpc();
  registerWolframIpc();
  registerWeatherIpc();
  registerMapsIpc();
  registerFilesIpc();
  registerSpotifyIpc();
  registerSpotifyAuthIpc();
  registerGoogleAuthIpc();
  registerMcpIpc();
  registerUpdaterEvents();
  registerUpdateIpc();
  createWindow();
  createTray();
  configureAutoLaunch();

  if (app.isPackaged) {
    // Silent launch check — errors (offline, rate-limited) are swallowed by
    // the 'error' handler above rather than surfaced as a popup.
    autoUpdater.checkForUpdates().catch(() => {});
  }

  app.on('activate', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    } else {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  // Intentionally not quitting — JARVIS keeps running in the tray on Windows.
});

app.on('before-quit', () => {
  app.isQuitting = true;
  stopMic();
  // Tear down the Playwright MCP child process so it doesn't outlive the app.
  mcpManager.stop().catch(() => {});
});
