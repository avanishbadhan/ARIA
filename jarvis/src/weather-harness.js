/**
 * JARVIS Weather Harness — resolves the current conditions at a given
 * latitude/longitude via Open-Meteo (a free, keyless weather API). The
 * Open-Meteo request itself runs in the Electron main process (see
 * registerWeatherIpc in electron/main.cjs), so this renderer harness holds
 * no credentials and never makes a CORS-prone call. Mirrors the McpWebHarness
 * shape: an `_isElectron()` gate plus a graceful "not available" fallback for
 * plain dev-browser mode (localhost:3000 without Electron).
 */

export class WeatherHarness {
  constructor(options = {}) {
    this.onLog = options.onLog || (() => {});
  }

  _isElectron() {
    return typeof window !== 'undefined' && !!window.jarvisElectron?.isElectron && !!window.jarvisElectron?.weather;
  }

  _notAvailable() {
    return { success: false, message: 'Live weather is not available outside the JARVIS desktop app, Sir.' };
  }

  /**
   * Maps Open-Meteo WMO weather codes to a short human description.
   */
  _describeWeather(code) {
    if (code === 0) return 'clear skies';
    if (code === 1) return 'mostly clear';
    if (code === 2) return 'partly cloudy';
    if (code === 3) return 'overcast';
    if (code >= 45 && code <= 48) return 'foggy';
    if (code >= 51 && code <= 57) return 'drizzle';
    if (code >= 61 && code <= 67) return 'rainy';
    if (code >= 71 && code <= 77) return 'snowy';
    if (code >= 80 && code <= 82) return 'showers';
    if (code >= 85 && code <= 86) return 'snow showers';
    if (code >= 95) return 'stormy';
    return 'variable';
  }

  /**
   * Returns the current weather at (lat, lon).
   * @param {number} lat
   * @param {number} lon
   * @returns {Promise<{success: boolean, temperatureC: number, feelsLikeC: number,
   *   humidityPct: number, windKmph: number, description: string, raw: object}|{success: false, message: string}>}
   */
  async getCurrentWeather(lat, lon) {
    if (!this._isElectron()) return this._notAvailable();
    try {
      const data = await window.jarvisElectron.weather.current(lat, lon);
      const current = data?.current;
      if (!current) return { success: false, message: "I couldn't retrieve live weather data, Sir." };

      const result = {
        success: true,
        latitude: data.latitude,
        longitude: data.longitude,
        temperatureC: Math.round(current.temperature_2m),
        feelsLikeC: Math.round(current.apparent_temperature),
        humidityPct: Math.round(current.relative_humidity_2m),
        windKmph: Math.round(current.wind_speed_10m),
        description: this._describeWeather(current.weather_code),
        raw: data
      };
      this.onLog({
        type: 'SUCCESS',
        message: `[WEATHER] ${result.temperatureC}°C, ${result.description} at ${lat.toFixed(4)}, ${lon.toFixed(4)}.`
      });
      return result;
    } catch (err) {
      this.onLog({ type: 'WARNING', message: `[WEATHER] getCurrentWeather failed: ${err.message}` });
      return { success: false, message: "I wasn't able to fetch the current weather, Sir." };
    }
  }
}
