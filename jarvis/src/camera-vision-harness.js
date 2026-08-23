/**
 * JARVIS Camera Vision Harness
 * Opens the local webcam and (a) runs a live TensorFlow.js/COCO-SSD object
 * detector over the feed, drawing bounding boxes onto an overlay canvas, and
 * (b) can capture a single frame and ask a vision-capable LLM a question
 * about it ("how many fingers am I holding up") — the same
 * capture-then-ask-an-LLM shape as screen-vision-harness.js, just sourced
 * from the webcam instead of a screenshot. DOM elements and the browser
 * APIs that touch them are all injected so this is testable headlessly,
 * same convention as every other harness in this codebase.
 */
export class CameraVisionHarness {
  constructor(options = {}) {
    this.videoEl = options.videoEl;
    this.canvasEl = options.canvasEl;
    this.panelEl = options.panelEl;
    this.onLog = options.onLog || (() => {});
    this.askVisionLLM = options.askVisionLLM || null;
    this.mediaDevices = options.mediaDevices || (typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined);
    this.loadModel = options.loadModel || (() => (typeof cocoSsd !== 'undefined' ? cocoSsd.load() : Promise.reject(new Error('cocoSsd is not available'))));
    this.requestAnimationFrame = options.requestAnimationFrame || (typeof window !== 'undefined' ? window.requestAnimationFrame.bind(window) : (fn) => setTimeout(fn, 16));
    this.cancelAnimationFrame = options.cancelAnimationFrame || (typeof window !== 'undefined' ? window.cancelAnimationFrame.bind(window) : clearTimeout);
    this.createElement = options.createElement || (typeof document !== 'undefined' ? document.createElement.bind(document) : null);
    this.delay = options.delay || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

    this.stream = null;
    this.isOpen = false;
    // In-flight acquisition guard: isOpen only flips true after getUserMedia
    // resolves, so two rapid open() calls would otherwise both start acquiring
    // and leak the first stream. Concurrent opens await this same promise.
    this._opening = null;
    this.model = null;
    this.isDetecting = false;
    this.animId = null;
  }

  async _ensureModelLoaded() {
    if (this.model) return;
    try {
      this.model = await this.loadModel();
      this.onLog({ type: 'SUCCESS', message: '[CAMERA VISION] Object detection model loaded.' });
    } catch (e) {
      this.onLog({ type: 'WARNING', message: `[CAMERA VISION] Failed to load detection model: ${e.message}` });
    }
  }

  async open() {
    if (this.isOpen) return { success: true, message: 'Camera feed is already active, Sir.' };
    if (this._opening) return this._opening;
    if (!this.mediaDevices?.getUserMedia) {
      return { success: false, message: 'Camera access is not available here, Sir.' };
    }

    this._opening = (async () => {
      try {
        this.stream = await this.mediaDevices.getUserMedia({ video: true });
        if (this.videoEl) this.videoEl.srcObject = this.stream;
        this.isOpen = true;
        this.panelEl?.classList.add('active');

        await this._ensureModelLoaded();
        this._startDetectionLoop();

        this.onLog({ type: 'SUCCESS', message: '[CAMERA VISION] Optical feed active.' });
        return { success: true, message: 'Camera feed active, Sir.' };
      } catch (e) {
        // If the stream was acquired but a later step failed, release the
        // freshly acquired tracks instead of leaking them.
        if (this.stream) {
          this.stream.getTracks().forEach(track => track.stop());
          this.stream = null;
        }
        this.onLog({ type: 'WARNING', message: `[CAMERA VISION] ${e.message}` });
        return { success: false, message: "I wasn't able to access the camera, Sir." };
      } finally {
        this._opening = null;
      }
    })();

    return this._opening;
  }

  close() {
    this._stopDetectionLoop();
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
      this.stream = null;
    }
    if (this.videoEl) this.videoEl.srcObject = null;
    this.panelEl?.classList.remove('active');
    this.isOpen = false;
    this.onLog({ type: 'HARNESS', message: '[CAMERA VISION] Optical feed deactivated.' });
    return { success: true, message: 'Camera feed deactivated, Sir.' };
  }

  async toggle() {
    return this.isOpen ? this.close() : this.open();
  }

  /**
   * Captures the current video frame as a JPEG data URL, or null if the
   * feed isn't producing frames yet (videoWidth is 0 until the browser
   * actually starts rendering the stream, which can lag a moment behind
   * getUserMedia's promise resolving).
   */
  _captureFrame() {
    if (!this.videoEl?.videoWidth || !this.createElement) return null;
    const canvas = this.createElement('canvas');
    canvas.width = this.videoEl.videoWidth;
    canvas.height = this.videoEl.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(this.videoEl, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.85);
  }

  // Polls in fixed 100ms steps up to maxAttempts (~3s at real speed) rather
  // than checking wall-clock time, so an injected no-op delay (tests) makes
  // this resolve near-instantly instead of still burning ~3 real seconds.
  async _waitForVideoReady(maxAttempts = 30) {
    let attempts = 0;
    while (!this.videoEl?.videoWidth && attempts < maxAttempts) {
      await this.delay(100);
      attempts++;
    }
  }

  /**
   * Captures a webcam frame and asks a vision-capable LLM a question about
   * it (via the injected askVisionLLM callback — see JarvisCore._askVisionLLM).
   * Opens the camera first if it wasn't already active, and closes it again
   * afterward if this call is the one that opened it — mirrors
   * ScreenVisionHarness.askAboutScreen's temporary-arm-then-restore pattern.
   */
  async askAboutCamera(question) {
    if (!this.mediaDevices?.getUserMedia) {
      return { success: false, message: 'Camera access is not available here, Sir.' };
    }

    const wasOpen = this.isOpen;
    if (!wasOpen) {
      const openResult = await this.open();
      if (!openResult.success) return openResult;
    }

    let result;
    try {
      if (!this.videoEl?.videoWidth) await this._waitForVideoReady();

      const frame = this._captureFrame();
      if (!frame) {
        this.onLog({ type: 'WARNING', message: '[CAMERA VISION] Could not capture a frame — video not ready.' });
        result = { success: false, message: "I wasn't able to get a clear look through the camera, Sir." };
      } else if (!this.askVisionLLM) {
        result = { success: false, message: "I couldn't process that with the camera right now, Sir." };
      } else {
        const answer = await this.askVisionLLM({ question, imageDataUrl: frame, source: 'camera' });
        if (answer) {
          this.onLog({ type: 'SUCCESS', message: `[CAMERA VISION] "${question}" answered from webcam frame.` });
          result = { success: true, message: answer };
        } else {
          this.onLog({ type: 'WARNING', message: '[CAMERA VISION] No vision-capable LLM provider available.' });
          result = { success: false, message: "I couldn't process that with the camera right now, Sir." };
        }
      }
    } catch (e) {
      this.onLog({ type: 'WARNING', message: `[CAMERA VISION] ${e.message}` });
      result = { success: false, message: "I wasn't able to read the camera feed, Sir." };
    }

    if (!wasOpen) this.close();
    return result;
  }

  _startDetectionLoop() {
    this.isDetecting = true;

    const loop = async () => {
      if (!this.isDetecting) return;

      if (this.model && this.videoEl?.videoWidth) {
        try {
          const predictions = await this.model.detect(this.videoEl);
          this._drawDetections(predictions);
        } catch (e) {
          this.onLog({ type: 'WARNING', message: `[CAMERA VISION] Detection error: ${e.message}` });
        }
      }

      this.animId = this.requestAnimationFrame(loop);
    };

    this.animId = this.requestAnimationFrame(loop);
  }

  _stopDetectionLoop() {
    this.isDetecting = false;
    if (this.animId) this.cancelAnimationFrame(this.animId);

    const ctx = this.canvasEl?.getContext?.('2d');
    if (ctx && this.canvasEl) ctx.clearRect(0, 0, this.canvasEl.width, this.canvasEl.height);
  }

  _drawDetections(predictions) {
    const ctx = this.canvasEl?.getContext?.('2d');
    if (!ctx || !this.canvasEl || !this.videoEl) return;

    ctx.clearRect(0, 0, this.canvasEl.width, this.canvasEl.height);
    const scaleX = this.canvasEl.width / this.videoEl.videoWidth;
    const scaleY = this.canvasEl.height / this.videoEl.videoHeight;

    predictions.forEach((prediction) => {
      const [x, y, width, height] = prediction.bbox;
      const scaledX = x * scaleX;
      const scaledY = y * scaleY;
      const scaledW = width * scaleX;
      const scaledH = height * scaleY;

      ctx.strokeStyle = '#00f0ff';
      ctx.lineWidth = 2;
      ctx.strokeRect(scaledX, scaledY, scaledW, scaledH);

      const labelText = `${prediction.class.toUpperCase()} ${Math.round(prediction.score * 100)}%`;

      ctx.fillStyle = '#020710';
      ctx.font = 'bold 10px Consolas, monospace';
      const labelWidth = ctx.measureText(labelText).width + 10;

      ctx.fillStyle = 'rgba(0, 240, 255, 0.85)';
      ctx.fillRect(scaledX, scaledY - 16, labelWidth, 16);

      ctx.fillStyle = '#020710';

      // The overlay canvas is CSS-mirrored (scaleX(-1)) so the bounding boxes
      // stay aligned with the mirrored video feed. Mirror the label back out so
      // it reads left-to-right after the CSS flip instead of appearing backwards.
      // NOTE: order matters — canvas transforms are post-multiplied, so
      // translate() must come BEFORE scale() here (translate-then-scale gives
      // canvasX = width - textX; the reverse order sends the text off-canvas).
      ctx.save();
      ctx.translate(this.canvasEl.width, 0);
      ctx.scale(-1, 1);
      ctx.fillText(labelText, this.canvasEl.width - scaledX - labelWidth + 5, scaledY - 4);
      ctx.restore();
    });
  }
}
