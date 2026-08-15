/**
 * JARVIS Camera Vision Harness
 * Opens the local webcam and runs a live TensorFlow.js/COCO-SSD object
 * detector over the feed, drawing bounding boxes onto an overlay canvas —
 * a real-time HUD panel, not an LLM vision call (contrast with
 * screen-vision-harness.js, which snapshots the screen and asks an LLM a
 * question about it). DOM elements and the browser APIs that touch them are
 * all injected so this is testable headlessly, same convention as every
 * other harness in this codebase.
 */
export class CameraVisionHarness {
  constructor(options = {}) {
    this.videoEl = options.videoEl;
    this.canvasEl = options.canvasEl;
    this.panelEl = options.panelEl;
    this.onLog = options.onLog || (() => {});
    this.mediaDevices = options.mediaDevices || (typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined);
    this.loadModel = options.loadModel || (() => (typeof cocoSsd !== 'undefined' ? cocoSsd.load() : Promise.reject(new Error('cocoSsd is not available'))));
    this.requestAnimationFrame = options.requestAnimationFrame || (typeof window !== 'undefined' ? window.requestAnimationFrame.bind(window) : (fn) => setTimeout(fn, 16));
    this.cancelAnimationFrame = options.cancelAnimationFrame || (typeof window !== 'undefined' ? window.cancelAnimationFrame.bind(window) : clearTimeout);

    this.stream = null;
    this.isOpen = false;
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
    if (!this.mediaDevices?.getUserMedia) {
      return { success: false, message: 'Camera access is not available here, Sir.' };
    }

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
      this.onLog({ type: 'WARNING', message: `[CAMERA VISION] ${e.message}` });
      return { success: false, message: "I wasn't able to access the camera, Sir." };
    }
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
      ctx.fillStyle = 'rgba(0, 240, 255, 0.85)';
      ctx.fillRect(scaledX, scaledY - 16, ctx.measureText(labelText).width + 10, 16);

      ctx.fillStyle = '#020710';
      ctx.font = 'bold 10px Consolas, monospace';
      ctx.fillText(labelText, scaledX + 5, scaledY - 4);
    });
  }
}
