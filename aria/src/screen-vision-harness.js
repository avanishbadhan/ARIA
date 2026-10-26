/**
 * JARVIS Screen Vision Harness
 * Captures a screenshot of the primary display via Electron's main process
 * and asks a vision-capable LLM to answer a question about it. Also owns the
 * floating blue "monitoring" indicator window's show/hide lifecycle, so
 * jarvis-core.js never touches window.jarvisElectron directly — same
 * convention as every other harness in this codebase.
 */
export class ScreenVisionHarness {
  constructor(options = {}) {
    this.onLog = options.onLog || (() => {});
    this.askVisionLLM = options.askVisionLLM;
    this.isMonitoring = false;
    this.overlayWindow = null;
  }

  async startMonitoring() {
    if (!window.jarvisElectron?.screen?.monitorShow) {
      return { success: false, message: 'Screen monitoring is only available in the desktop app, Sir.' };
    }
    await window.jarvisElectron.screen.monitorShow();
    this.isMonitoring = true;
    this.onLog({ type: 'SUCCESS', message: '[SCREEN VISION] Monitoring armed — indicator shown.' });
    return { success: true, message: 'Monitoring your screen now, Sir.' };
  }

  async stopMonitoring() {
    if (window.jarvisElectron?.screen?.monitorHide) {
      await window.jarvisElectron.screen.monitorHide();
    }
    this.isMonitoring = false;
    this.onLog({ type: 'HARNESS', message: '[SCREEN VISION] Monitoring disarmed — indicator hidden.' });
    return { success: true, message: 'Stopped monitoring, Sir.' };
  }

  async startOverlay() {
    if (!window.jarvisElectron?.screen?.capturePrimary) {
      return { success: false, message: 'Screen capture is only available in the desktop app, Sir.' };
    }
    if (!this.overlayWindow) {
      const { BrowserWindow } = window.jarvisElectron;
      const workArea = screen.getPrimaryDisplay().workArea;
      this.overlayWindow = new BrowserWindow({
        width: 420,
        height: 340,
        x: workArea.x + 20,
        y: workArea.y + 20,
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
      this.overlayWindow.loadFile(path.join(__dirname, '..', '..', 'electron', 'overlay.html'));
      this.overlayWindow.setIgnoreMouseEvents(true, { forward: true });
      this.overlayWindow.on('closed', () => { this.overlayWindow = null; });
    }
    this.overlayWindow.showInactive();
    this.onLog({ type: 'SUCCESS', message: '[SCREEN VISION] Overlay window shown.' });
    return { success: true, message: 'Overlay window shown, Sir.' };
  }

  async stopOverlay() {
    if (this.overlayWindow) {
      this.overlayWindow.hide();
      this.overlayWindow = null;
      this.onLog({ type: 'HARNESS', message: '[SCREEN VISION] Overlay window hidden.' });
    }
    return { success: true, message: 'Overlay window hidden, Sir.' };
  }

  async askAboutScreen(question) {
    if (!window.jarvisElectron?.screen?.capturePrimary) {
      return { success: false, message: 'Screen capture is only available in the desktop app, Sir.' };
    }

    // In-flight guard: two rapid asks while not monitoring would each see
    // wasMonitoring=false, so the first restore would hide the indicator
    // while the second capture was still running (and monitorShow would fire
    // twice). Concurrent calls await this same acquisition instead.
    if (this._askInFlight) return this._askInFlight;

    this._askInFlight = (async () => {
      const wasMonitoring = this.isMonitoring;
      if (!wasMonitoring && window.jarvisElectron.screen.monitorShow) {
        await window.jarvisElectron.screen.monitorShow();
      }

      let result;
      try {
        const capture = await window.jarvisElectron.screen.capturePrimary();
        if (!capture.success) {
          this.onLog({ type: 'WARNING', message: `[SCREEN VISION] Capture failed: ${capture.error}` });
          result = { success: false, message: "I wasn't able to capture your screen, Sir." };
        } else if (!this.askVisionLLM) {
          result = { success: false, message: "I couldn't read your screen right now, Sir." };
        } else {
          const answer = await this.askVisionLLM({ question, imageDataUrl: capture.dataUrl });
          if (answer) {
            this.onLog({ type: 'SUCCESS', message: `[SCREEN VISION] "${question}" answered from screenshot.` });
            result = { success: true, message: answer };
          } else {
            this.onLog({ type: 'WARNING', message: '[SCREEN VISION] No vision-capable LLM provider available.' });
            result = { success: false, message: "I couldn't read your screen right now, Sir." };
          }
        }
      } catch (e) {
        this.onLog({ type: 'WARNING', message: `[SCREEN VISION] ${e.message}` });
        result = { success: false, message: "I couldn't read your screen right now, Sir." };
      }

      if (!wasMonitoring && window.jarvisElectron.screen.monitorHide) {
        await window.jarvisElectron.screen.monitorHide();
      }

      return result;
    })();

    try {
      return await this._askInFlight;
    } finally {
      this._askInFlight = null;
    }
  }
}
