/**
 * JARVIS Settings
 * Small localStorage-backed preferences store for user-facing toggles.
 * API keys are NOT stored here — they keep using their own existing
 * localStorage keys (jarvis_openrouter_api_key, jarvis_deepgram_api_key,
 * jarvis_steam_api_key, jarvis_steam_id), already read directly by
 * jarvis-core.js / voice-engine.js / steam-library.js.
 */

const STORAGE_KEY = 'jarvis_settings';

export const DEFAULT_SETTINGS = {
  openTabOnSearch: true,
  voiceGender: 'male',
  soundMeterEnabled: true,
  useGroq: false,
  groqModelTier: 'quick'
};

export function loadSettings() {
  let stored = {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) stored = JSON.parse(raw);
  } catch (e) {
    stored = {};
  }
  return { ...DEFAULT_SETTINGS, ...stored };
}

export function saveSettings(partial) {
  const merged = { ...loadSettings(), ...partial };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
  return merged;
}
