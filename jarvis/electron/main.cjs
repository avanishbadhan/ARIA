const { app, BrowserWindow, Tray, Menu, shell, session, ipcMain, nativeImage, safeStorage, desktopCapturer, screen } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { classifyUpdate } = require('./update-classify.cjs');

const DEV_URL = 'http://localhost:3000';
const ICON_PATH = path.join(__dirname, 'icon.png');
const SPEECH_SCRIPT_PATH = path.join(__dirname, 'speech-recognizer.ps1');

// Local loopback redirect for Spotify's Authorization Code OAuth flow — this
// exact URI must be added to the app's "Redirect URIs" in the Spotify
// Developer Dashboard (developer.spotify.com/dashboard) for login to work.
const SPOTIFY_REDIRECT_PORT = 43417;
const SPOTIFY_REDIRECT_URI = `http://127.0.0.1:${SPOTIFY_REDIRECT_PORT}/callback`;
const SPOTIFY_AUTH_SCOPES = 'playlist-read-private playlist-read-collaborative user-library-read';

let mainWindow = null;
let tray = null;
let micProcess = null;
let indicatorWindow = null;
app.isQuitting = false;

// Auto-download only kicks in for major bumps (see update-classify.cjs) —
// minor/patch updates wait for an explicit renderer-triggered download.
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;
let pendingUpdate = null; // { version, classification } once update-available fires
let updateReadyToInstall = false;

// Only one JARVIS instance/tray icon at a time.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
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
    title: 'J.A.R.V.I.S.',
    icon: ICON_PATH,
    backgroundColor: '#05070c',
    autoHideMenuBar: true,
    // Start hidden — JARVIS lives in the tray and listens in the background;
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

  // steam:// (and any other non-http) links must go to the OS, not Electron's
  // own navigation — Electron won't resolve custom protocols like a real browser.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  // window.open() calls (Google search tabs, Store search fallback, site links)
  // should open in the user's default browser, not spawn a second Electron window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Closing the window minimizes to tray instead of quitting the app.
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

function createTray() {
  const icon = nativeImage.createFromPath(ICON_PATH);
  tray = new Tray(icon.isEmpty() ? icon : icon.resize({ width: 16, height: 16 }));
  tray.setToolTip('J.A.R.V.I.S. Voice AI');

  const menu = Menu.buildFromTemplate([
    { label: 'Show JARVIS', click: () => { mainWindow.show(); mainWindow.focus(); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } }
  ]);
  tray.setContextMenu(menu);

  tray.on('click', () => {
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

function startMic() {
  if (micProcess) return; // already running

  micProcess = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SPEECH_SCRIPT_PATH
  ], { windowsHide: true });

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
        mainWindow.webContents.send('mic:transcript', { text: msg.text, isFinal: msg.type === 'final', alternatives: msg.alternatives || [] });
      } else if (msg.type === 'error') {
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
  ipcMain.handle('mic:start', () => { startMic(); });
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
  if (!safeStorage.isEncryptionAvailable()) return;
  fs.writeFileSync(spotifyTokensPath(), safeStorage.encryptString(JSON.stringify(tokens)));
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
          `<h2>JARVIS: Spotify ${ok ? 'connected' : 'connection failed'}.</h2>` +
          `<p style="color:#8899aa">You can close this tab and return to JARVIS.</p></body></html>`
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
          saveSpotifyTokens({
            access_token: tokenResp.access_token,
            refresh_token: tokenResp.refresh_token,
            expires_at: Date.now() + tokenResp.expires_in * 1000
          });
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

function sendUpdateState(state) {
  if (mainWindow) mainWindow.webContents.send('update:state', state);
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

  ipcMain.handle('update:check', () => {
    if (!app.isPackaged) {
      // Dev builds have no publish feed to compare against — report idle
      // instead of letting electron-updater throw on a missing app-update.yml.
      sendUpdateState({ status: 'idle' });
      return;
    }
    autoUpdater.checkForUpdates();
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
      path: '/repos/Taksh-Biyani/jarvis-voice-ai/releases?per_page=10',
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
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(permission === 'media');
  });

  registerSteamIpc();
  registerGameLibraryIpc();
  registerMicIpc();
  registerScreenCaptureIpc();
  registerScreenMonitorIpc();
  registerWolframIpc();
  registerSpotifyIpc();
  registerSpotifyAuthIpc();
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
    if (mainWindow) {
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
});
