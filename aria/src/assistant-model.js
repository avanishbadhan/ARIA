// ARIA assistant model visualization — Three.js rendering of
// exploded_assembly_hq.glb as the central animated hero.
//
// The GLB has 79 mesh nodes behind eight mechanical families (hub_*, d1_*,
// d2_*, red_*, gear_*, planet_*, shell_*, dial_*), a shared diagonal
// rotational axis baked into the geometry, and no baked animations. All
// node transforms are identity, so each family is wrapped in a named
// THREE.Group that stays at the world origin: rotating the group rotates
// its children around the shared axis through the origin (vertex
// positions preserved), and translating the group along that same axis
// drives the exploded-spacing / retraction effects.
//
// Public surface (module exports createAssistantModel()):
//   { setState, forceState, feedAudio, setAudioLevel, renderOnce, dispose }
// `feedAudio` respects a temporary test override set by forceAudio().

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

// The model's shared rotational axis (diagonal, through the world origin).
// Components rotate around it, and axial spacing moves along it.
const AXIS_RAW = { x: 0.913089, y: 0.395084, z: 0.100882 };
const AXIS_UNIT = (() => {
  const v = new THREE.Vector3(AXIS_RAW.x, AXIS_RAW.y, AXIS_RAW.z);
  return v.normalize();
})();

// Mechanical families → animation group. Anything outside these prefixes
// still renders, just without animation.
const FAMILY_KEYS = ['hub', 'd1', 'd2', 'red', 'gear', 'planet', 'shell', 'dial'];

// Reference axial centers along the shared axis (from model inspection).
// Used as the spacing map when layers retract/expand; the loader also
// measures each family's real centroid for verification logging.
const AXIAL_CENTERS = {
  hub: -5.25, d1: -3.70, d2: -2.40, red: -1.10,
  gear: 0.30, planet: 1.55, shell: 2.75, dial: 4.45
};

// Per-family spin speeds (rad/s, idle). Signs create counter-rotation.
const SPIN_SPEEDS = {
  hub: 0.012, d1: -0.030, d2: 0.042, red: 0.060,
  gear: 0.050, planet: -0.036, shell: 0.020, dial: 0.026
};

// State-driven multipliers.
const STATE_SPIN_MULT = {
  idle: 1.0, listening: 1.15, thinking: 3.5, speaking: 1.8
};

// Thinking: some layers retract toward the center along the shared axis
// (mechanical clockwork processing effect). Values are spacing scales.
const THINKING_SPACING = {
  hub: 1.0, d1: 0.85, d2: 0.85, red: 1.0,
  gear: 0.62, planet: 0.62, shell: 0.72, dial: 0.66
};

// Idle color of the active illumination (the red core family), and the
// thinking target (amber/yellow).
const RED_EMISSIVE = new THREE.Color(1.0, 0.12, 0.10);
const AMBER_EMISSIVE = new THREE.Color(1.0, 0.66, 0.14);

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function createAssistantModel({ canvas, getSpeechAudio } = {}) {
  if (!canvas) throw new Error('[ARIA-VIZ] createAssistantModel requires a canvas');
  const canvasEl = canvas;

  const renderer = new THREE.WebGLRenderer({
    canvas: canvasEl,
    alpha: true,
    antialias: true,
    // Frame captures (testing) read back cleanly with a preserved buffer.
    preserveDrawingBuffer: true,
    powerPreference: 'high-performance'
  });
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 200);
  // Oblique framing: offset from the shared axis so the assembly reads as
  // a tilted exploded mechanism, not a straight-on column.
  const CAM_DIR = new THREE.Vector3(0.34, 0.52, 0.78).normalize();
  const CAM_DIST_SCALE = 2.45;

  // Lighting: metallic kit — soft key, cool fill, warm rim near the core.
  const keyLight = new THREE.DirectionalLight(0xdfeaff, 2.6);
  keyLight.position.set(6, 10, 8);
  const fillLight = new THREE.DirectionalLight(0x8fb4ff, 1.1);
  fillLight.position.set(-8, 3, -6);
  const rimLight = new THREE.DirectionalLight(0xffd9a0, 1.4);
  rimLight.position.set(-3, -6, 10);
  const corePoint = new THREE.PointLight(0xff5a30, 12, 18, 2);
  scene.add(keyLight, fillLight, rimLight, corePoint, new THREE.AmbientLight(0x445065, 1.4));

  // Subtle bloom.
  let composer = null;
  let bloomPass = null;
  try {
    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.32, 0.55, 0.82);
    composer.addPass(bloomPass);
    composer.addPass(new OutputPass());
  } catch (e) {
    console.warn('[ARIA-VIZ] bloom unavailable, rendering direct:', e);
    composer = null;
  }

  const reducedMotion = window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const MOTION_MULT = reducedMotion ? 0.18 : 1.0;

  // ---- Animation state ------------------------------------------------
  const groups = {};           // family → THREE.Group
  const meshesByFamily = {};   // family → [Mesh,...]
  let materials = [];          // all original GLB materials (preserved)
  let envelope = null;         // { center: Vector3, radius: number }
  let disposed = false;

  // Smoothed live values.
  let state = 'idle';
  let forcedState = null;
  let spinMult = 1.0;          // smoothed STATE_SPIN_MULT
  let spacing = 1.0;           // smoothed global spacing (speaking breathing)
  let levelRaw = 0;            // last fed audio level (0..1)
  let levelSmooth = 0;
  let forcedAudio = null;      // test-override audio level
  const angles = {};           // family → rotation angle around AXIS
  for (const k of FAMILY_KEYS) angles[k] = 0;

  // ---- Loading ---------------------------------------------------------
  const loader = new GLTFLoader();
  // public/models/… is served at the site root in dev (/models/…) and
  // copied into dist/ root by the build, so one relative path works for
  // both the dev server and the packaged Electron file:// app.
  const MODEL_URL = new URL('../models/exploded_assembly_hq.glb', import.meta.url).href;

  const loadPromise = new Promise((resolve) => {
    loader.load(
      MODEL_URL,
      (gltf) => {
        try { setupModel(gltf); resolve(true); } catch (e) { console.error('[ARIA-VIZ] setup failed:', e); resolve(false); }
      },
      undefined,
      (err) => { console.error('[ARIA-VIZ] failed to load GLB:', err); resolve(false); }
    );
  });

  function familyOf(name) {
    const lower = String(name || '').toLowerCase();
    for (const k of FAMILY_KEYS) {
      if (lower.startsWith(k + '_') || lower.startsWith(k + '0') || lower === k) return k;
    }
    return null;
  }

  function setupModel(gltf) {
    const root = gltf.scene;
    // Families.
    const familyRoots = {};
    for (const k of FAMILY_KEYS) {
      const g = new THREE.Group();
      g.name = `ARIA_${k}`;
      scene.add(g);
      groups[k] = g;
      meshesByFamily[k] = [];
      familyRoots[k] = g;
    }
    // Collect first (no graph mutation during traversal), attach after.
    const loose = [];
    const byFamily = {};
    for (const k of FAMILY_KEYS) byFamily[k] = [];
    root.traverse((obj) => {
      if (!obj.isMesh) return;
      const fam = familyOf(obj.name);
      if (!fam) { loose.push(obj); return; }
      byFamily[fam].push(obj);
    });
    for (const fam of FAMILY_KEYS) {
      for (const obj of byFamily[fam]) {
        familyRoots[fam].add(obj); // position stays baked; group is at origin
        meshesByFamily[fam].push(obj);
      }
    }
    // Anything that did not land in a family keeps rendering as-is.
    if (loose.length) {
      scene.add(...loose);
      console.warn(`[ARIA-VIZ] ${loose.length} meshes outside the 8 families render static:`,
        loose.slice(0, 8).map((m) => m.name));
    }
    // Compute vertex normals for meshes missing NORMAL attributes.
    let fixed = 0;
    scene.traverse((obj) => {
      if (!obj.isMesh) return;
      if (!obj.geometry.attributes.normal) { obj.geometry.computeVertexNormals(); fixed++; }
    });
    if (fixed) console.info(`[ARIA-VIZ] computed vertex normals for ${fixed} meshes`);
    materials = [];
    root.traverse((obj) => {
      if (obj.isMesh) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of mats) if (m && !materials.includes(m)) materials.push(m);
      }
    });
    // Envelope for camera framing: union of everything that renders (the
    // GLB root is empty now that meshes live in the family groups).
    const box = new THREE.Box3();
    for (const k of FAMILY_KEYS) {
      if (groups[k]) box.expandByObject(groups[k]);
    }
    for (const obj of loose) {
      box.expandByObject(obj);
    }
    const center = box.getCenter(new THREE.Vector3());
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    envelope = { center, radius: Math.max(0.001, sphere.radius) };
    camera.position.copy(CAM_DIR).multiplyScalar(envelope.radius * CAM_DIST_SCALE).add(center);
    camera.lookAt(center);
    // Debug: measured axial centers vs reference table.
    const report = {};
    for (const k of FAMILY_KEYS) {
      const b = new THREE.Box3().setFromObject(groups[k]);
      const c = b.getCenter(new THREE.Vector3());
      report[k] = {
        meshes: meshesByFamily[k].length,
        axialRef: AXIAL_CENTERS[k],
        axialMeasured: +c.dot(AXIS_UNIT).toFixed(3)
      };
    }
    console.info('[ARIA-VIZ] model loaded. groups:', report, { materials: materials.length });
    attachEmissiveTracking();
  }

  // Active illumination: track emissive-capable materials per family. The
  // red family drives the full red→amber thinking transition; dials take a
  // milder pulse so the frame never blows out.
  let redMats = [];
  let dialMats = [];
  function attachEmissiveTracking() {
    redMats = []; dialMats = [];
    for (const m of meshesByFamily.red || []) {
      const list = Array.isArray(m.material) ? m.material : [m.material];
      list.forEach((x) => { if (x && 'emissive' in x && !redMats.includes(x)) redMats.push(x); });
    }
    for (const m of meshesByFamily.dial || []) {
      const list = Array.isArray(m.material) ? m.material : [m.material];
      list.forEach((x) => { if (x && 'emissive' in x && !dialMats.includes(x) && !redMats.includes(x)) dialMats.push(x); });
    }
    console.info('[ARIA-VIZ] active-illumination materials: red', redMats.length,
      'dial', dialMats.length);
  }

  // ---- Public API ------------------------------------------------------
  function setState(next) {
    if (['idle', 'listening', 'thinking', 'speaking'].includes(next)) state = next;
  }
  function forceState(s) {
    forcedState = s && ['idle', 'listening', 'thinking', 'speaking'].includes(s) ? s : null;
  }
  function feedAudio(level) {
    levelRaw = clamp01(Number(level) || 0);
  }
  function setAudioLevel(level) {
    forcedAudio = level == null ? null : clamp01(Number(level) || 0);
  }
  function effectiveState() { return forcedState || state; }
  function effectiveLevel() { return forcedAudio != null ? forcedAudio : Math.max(levelRaw, ttsRms()); }

  // ---- TTS amplitude tap ----------------------------------------------
  // When the ElevenLabs reply plays through a real <audio> element, its
  // actual waveform drives the speaking breathing (setAudioLevel fallback:
  // mic meter pulses). Routing runs through WebAudio; any failure leaves
  // playback untouched and falls back to the meter level.
  let audioCtx = null;
  const ttsSources = new WeakMap(); // audio element → { source, analyser, buf }
  function ttsRms() {
    let el = null;
    try { el = typeof getSpeechAudio === 'function' ? getSpeechAudio() : null; } catch (e) { el = null; }
    if (!el || el.paused || !el.src) return 0;
    try {
      let entry = ttsSources.get(el);
      if (!entry) {
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state !== 'running') {
          audioCtx.resume?.();
          if (audioCtx.state !== 'running') return 0; // no gesture-less unlock yet
        }
        const source = audioCtx.createMediaElementSource(el);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        analyser.connect(audioCtx.destination); // audio must still reach the speakers
        entry = { analyser, buf: new Float32Array(analyser.fftSize) };
        ttsSources.set(el, entry);
      }
      entry.analyser.getFloatTimeDomainData(entry.buf);
      let sum = 0;
      for (let i = 0; i < entry.buf.length; i++) sum += entry.buf[i] * entry.buf[i];
      const rms = Math.sqrt(sum / entry.buf.length);
      return clamp01(rms * 7.5);
    } catch (e) {
      return 0; // WebAudio unavailable — meter fallback drives breathing
    }
  }

  // One synchronous render (used by tests to capture a frame without rAF).
  function renderOnce() {
    if (disposed || !envelope) return false;
    resize();
    renderFrame();
    return true;
  }

  function dispose() {
    disposed = true;
    ro?.disconnect();
    if (composer) composer.dispose?.();
    try { audioCtx && audioCtx.close(); } catch (e) {}
    audioCtx = null;
    renderer.dispose();
  }

  // ---- Rendering -------------------------------------------------------
  function renderFrame() {
    const t = performance.now() / 1000;

    // Smoothed drivers.
    const spinTarget = STATE_SPIN_MULT[effectiveState()] || 1;
    spinMult += (spinTarget - spinMult) * 0.035;
    // Audio: attack fast, release slow — never jerky.
    const lv = effectiveLevel();
    levelSmooth += (lv - levelSmooth) * (lv > levelSmooth ? 0.35 : 0.07);

    // Global spacing: expanded breathing driven by speech energy.
    const spacingTarget = 1 + levelSmooth * 0.22;
    spacing += (spacingTarget - spacing) * 0.08;

    // Spin + axial placement per family.
    const dt = 1 / 60;
    for (const k of FAMILY_KEYS) {
      const g = groups[k];
      if (!g) continue;
      angles[k] += SPIN_SPEEDS[k] * spinMult * MOTION_MULT * dt;
      // Rotate around the shared diagonal axis through the origin. Identity
      // node transforms mean the group's quaternion is applied directly to
      // baked vertex positions — no per-mesh axis surgery required.
      g.quaternion.setFromAxisAngle(AXIS_UNIT, angles[k]);
      const center = AXIAL_CENTERS[k] || 0;
      const famScale = effectiveState() === 'thinking' ? (THINKING_SPACING[k] || 1) : 1;
      g.position.copy(AXIS_UNIT).multiplyScalar(center * spacing * famScale);
    }

    // Active illumination: thinking transitions red → amber/yellow. Kept
    // restrained — bloom amplifies, so emissive stays under ~0.8 intensity
    // or the assembly white-clips.
    const isThinking = effectiveState() === 'thinking';
    const isSpeaking = effectiveState() === 'speaking';
    const isListening = effectiveState() === 'listening';
    const glowLevel = isThinking
      ? 0.5 + 0.5 * Math.sin(t * 2.2)
      : (isListening ? 0.3 + 0.3 * levelSmooth
        : (isSpeaking ? 0.25 + 0.4 * levelSmooth : 0.15));
    for (const m of redMats) {
      if (isThinking) {
        m.emissive.copy(RED_EMISSIVE).lerp(AMBER_EMISSIVE, 0.5 + 0.5 * Math.sin(t * 1.1));
        m.emissiveIntensity = 0.4 + 0.4 * glowLevel;
      } else {
        m.emissive.copy(RED_EMISSIVE);
        m.emissiveIntensity = 0.3 * glowLevel;
      }
    }
    for (const m of dialMats) {
      m.emissive.copy(isThinking ? AMBER_EMISSIVE : RED_EMISSIVE);
      m.emissiveIntensity = 0.15 * glowLevel;
    }

    // Listening/speaking lighting pulses drive lights, not geometry.
    keyLight.intensity = 2.6 * (1 + 0.22 * glowLevel * MOTION_MULT);
    corePoint.intensity = 10 + 5 * glowLevel;
    if (bloomPass) bloomPass.strength = 0.30 + 0.10 * glowLevel * MOTION_MULT;

    if (composer) composer.render();
    else renderer.render(scene, camera);
  }

  function resize() {
    const w = canvasEl.clientWidth || canvasEl.parentElement?.clientWidth || 1;
    const h = canvasEl.clientHeight || canvasEl.parentElement?.clientHeight || 1;
    if (!w || !h) return;
    const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    const bw = Math.max(1, Math.floor(w * dpr));
    const bh = Math.max(1, Math.floor(h * dpr));
    if (canvasEl.width !== bw || canvasEl.height !== bh) { canvasEl.width = bw; canvasEl.height = bh; }
    renderer.setSize(bw, bh, false);
    renderer.setPixelRatio(1); // backing store set explicitly above
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (composer) composer.setSize(bw, bh);
  }

  const ro = new ResizeObserver(resize);
  ro.observe(canvasEl);

  let frameId = null;
  function loop() {
    if (disposed) return;
    frameId = requestAnimationFrame(loop);
    if (document.hidden) return;
    // Keep the backing store in lockstep with CSS size (ResizeObserver plus
    // a belt-and-braces per-frame check for layout races).
    const cw = canvasEl.clientWidth, chh = canvasEl.clientHeight;
    const dpr0 = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    const wantW = Math.max(1, Math.floor(cw * dpr0));
    const wantH = Math.max(1, Math.floor(chh * dpr0));
    if (canvasEl.width !== wantW || canvasEl.height !== wantH) resize();
    if (!cw || !chh) return;
    renderFrame();
  }
  loop();

  return {
    ready: loadPromise,
    setState,
    forceState,
    feedAudio,
    setAudioLevel,
    renderOnce,
    dispose,
    // Debug surfaces (used by tests; harmless in production).
    _debug: {
      get groups() { return groups; },
      get envelope() { return envelope; },
      get renderer() { return renderer; },
      get camera() { return camera; }
    }
  };
}
