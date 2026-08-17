/**
 * JARVIS Maps Harness — nearby-place search and driving directions via the
 * free, keyless OpenStreetMap stack (Nominatim geocoding, Overpass place
 * search, OSRM routing). The actual requests run in the Electron main process
 * (see registerMapsIpc in electron/main.cjs), so this renderer harness holds
 * no credentials and never makes a CORS-prone call. Mirrors the WeatherHarness
 * shape: an `_isElectron()` gate plus a graceful "not available" fallback for
 * plain dev-browser mode (localhost:3000 without Electron).
 *
 * Note on public server usage: Overpass, Nominatim, and OSRM's public demo
 * servers are free but rate-limited and intended for light, non-bulk use.
 * Fine for a single personal-assistant user; a self-hosted or paid instance
 * would be needed if usage ever scaled up.
 */

export class MapsHarness {
  constructor(options = {}) {
    this.onLog = options.onLog || (() => {});
  }

  _isElectron() {
    return typeof window !== 'undefined' && !!window.jarvisElectron?.isElectron && !!window.jarvisElectron?.maps;
  }

  _notAvailable() {
    return { success: false, message: 'Live maps are not available outside the JARVIS desktop app, Sir.' };
  }

  /**
   * Finds nearby places matching `query` around (lat, lon).
   * @param {number} lat
   * @param {number} lon
   * @param {string} query
   * @returns {Promise<{success: boolean, places: [{name: string, distanceMi: number, address: string}]}|{success: false, message: string}>}
   */
  async findNearbyPlaces(lat, lon, query) {
    if (!this._isElectron()) return this._notAvailable();
    try {
      const data = await window.jarvisElectron.maps.findNearby(lat, lon, query);
      if (!data?.success) {
        return { success: false, message: data?.message || "I couldn't find anything nearby, Sir." };
      }
      const places = (data.places || []).map((p) => ({
        name: p.name,
        distanceMi: p.distanceMi,
        address: p.address
      }));
      this.onLog({
        type: 'SUCCESS',
        message: `[MAPS] Found ${places.length} nearby place(s) for "${query}" at ${lat.toFixed(4)}, ${lon.toFixed(4)}.`
      });
      return { success: true, places };
    } catch (err) {
      this.onLog({ type: 'WARNING', message: `[MAPS] findNearbyPlaces failed: ${err.message}` });
      return { success: false, message: "I wasn't able to reach the map service, Sir." };
    }
  }

  /**
   * Gets a driving route summary from (lat, lon) to a destination.
   * @param {number} lat
   * @param {number} lon
   * @param {string} destinationQuery
   * @returns {Promise<{success: boolean, distanceMi: number, durationMin: number, destinationLabel: string}|{success: false, message: string}>}
   */
  async getDirections(lat, lon, destinationQuery) {
    if (!this._isElectron()) return this._notAvailable();
    try {
      const data = await window.jarvisElectron.maps.getDirections(lat, lon, destinationQuery);
      if (!data?.success) {
        return { success: false, message: data?.message || "I couldn't find that place, Sir." };
      }
      const result = {
        success: true,
        distanceMi: data.distanceMi,
        durationMin: data.durationMin,
        destinationLabel: data.destinationLabel
      };
      this.onLog({
        type: 'SUCCESS',
        message: `[MAPS] Directions to "${destinationQuery}": ${result.distanceMi} mi, ~${result.durationMin} min by car.`
      });
      return result;
    } catch (err) {
      this.onLog({ type: 'WARNING', message: `[MAPS] getDirections failed: ${err.message}` });
      return { success: false, message: "I wasn't able to reach the map service, Sir." };
    }
  }
}
