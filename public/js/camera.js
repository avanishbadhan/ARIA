import { el, state } from './state.js';
import { log } from './log.js';

const overlayCtx = el.overlayCanvas.getContext('2d');
const hiddenCanvas = document.createElement('canvas');
const hiddenContext = hiddenCanvas.getContext('2d');

export async function loadObjectDetectionModel() {
    try {
        state.cocoModel = await cocoSsd.load();
        log("J.A.R.V.I.S.", "Bounding Box Object Detection Engine loaded.", "jarvis-log");
    } catch (err) {
        console.error("Error loading object detection model:", err);
    }
}

export async function toggleCamera(forceState) {
    const shouldOpen = forceState !== undefined ? forceState : !el.cameraPanel.classList.contains('active');
    if (shouldOpen) {
        try {
            state.cameraStream = await navigator.mediaDevices.getUserMedia({ video: true });
            el.cameraVideo.srcObject = state.cameraStream;
            el.cameraPanel.classList.add('active');

            el.cameraVideo.onloadedmetadata = () => {
                el.overlayCanvas.width = el.cameraVideo.clientWidth;
                el.overlayCanvas.height = el.cameraVideo.clientHeight;
                startObjectDetection();
            };
            return "Optical feed initialized with target tracking.";
        } catch (err) {
            console.error("Camera access error:", err);
            return "Unable to access optical sensor.";
        }
    } else {
        stopObjectDetection();
        if (state.cameraStream) {
            state.cameraStream.getTracks().forEach(track => track.stop());
            state.cameraStream = null;
        }
        el.cameraVideo.srcObject = null;
        el.cameraPanel.classList.remove('active');
        return "Optical feed deactivated.";
    }
}

function startObjectDetection() {
    state.isDetectionActive = true;
    detectFrame();
}

function stopObjectDetection() {
    state.isDetectionActive = false;
    if (state.detectionAnimId) cancelAnimationFrame(state.detectionAnimId);
    overlayCtx.clearRect(0, 0, el.overlayCanvas.width, el.overlayCanvas.height);
}

async function detectFrame() {
    if (!state.isDetectionActive || !state.cocoModel || !el.cameraVideo.videoWidth) {
        state.detectionAnimId = requestAnimationFrame(detectFrame);
        return;
    }

    try {
        const predictions = await state.cocoModel.detect(el.cameraVideo);
        drawHUDOverlays(predictions);
    } catch (err) {
        console.error("Detection cycle error:", err);
    }

    state.detectionAnimId = requestAnimationFrame(detectFrame);
}

function drawHUDOverlays(predictions) {
    overlayCtx.clearRect(0, 0, el.overlayCanvas.width, el.overlayCanvas.height);

    const scaleX = el.overlayCanvas.width / el.cameraVideo.videoWidth;
    const scaleY = el.overlayCanvas.height / el.cameraVideo.videoHeight;

    predictions.forEach(prediction => {
        const [x, y, width, height] = prediction.bbox;
        const scaledX = x * scaleX;
        const scaledY = y * scaleY;
        const scaledW = width * scaleX;
        const scaledH = height * scaleY;

        overlayCtx.strokeStyle = '#00f0ff';
        overlayCtx.lineWidth = 2;
        overlayCtx.shadowColor = '#00f0ff';
        overlayCtx.shadowBlur = 8;
        overlayCtx.strokeRect(scaledX, scaledY, scaledW, scaledH);

        const cornerLen = 10;
        overlayCtx.strokeStyle = '#ffffff';
        overlayCtx.lineWidth = 3;

        overlayCtx.beginPath();
        overlayCtx.moveTo(scaledX, scaledY + cornerLen);
        overlayCtx.lineTo(scaledX, scaledY);
        overlayCtx.lineTo(scaledX + cornerLen, scaledY);
        overlayCtx.stroke();

        overlayCtx.beginPath();
        overlayCtx.moveTo(scaledX + scaledW - cornerLen, scaledY);
        overlayCtx.lineTo(scaledX + scaledW, scaledY);
        overlayCtx.lineTo(scaledX + scaledW, scaledY + cornerLen);
        overlayCtx.stroke();

        const labelText = `${prediction.class.toUpperCase()} ${Math.round(prediction.score * 100)}%`;
        overlayCtx.fillStyle = 'rgba(0, 240, 255, 0.85)';
        overlayCtx.fillRect(scaledX, scaledY - 20, overlayCtx.measureText(labelText).width + 12, 20);

        overlayCtx.fillStyle = '#020710';
        overlayCtx.font = 'bold 10px Consolas, monospace';
        overlayCtx.shadowBlur = 0;
        overlayCtx.fillText(labelText, scaledX + 6, scaledY - 6);

        const centerX = scaledX + (scaledW / 2);
        const centerY = scaledY + (scaledH / 2);
        overlayCtx.strokeStyle = 'rgba(0, 240, 255, 0.6)';
        overlayCtx.beginPath();
        overlayCtx.arc(centerX, centerY, 4, 0, 2 * Math.PI);
        overlayCtx.stroke();
    });
}

export function captureCameraFrame() {
    if (!state.cameraStream || !el.cameraVideo.videoWidth) return null;
    hiddenCanvas.width = el.cameraVideo.videoWidth;
    hiddenCanvas.height = el.cameraVideo.videoHeight;
    hiddenContext.drawImage(el.cameraVideo, 0, 0, hiddenCanvas.width, hiddenCanvas.height);
    const dataUrl = hiddenCanvas.toDataURL('image/jpeg', 0.8);
    return dataUrl.split(',')[1];
}
