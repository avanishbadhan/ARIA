import test from 'node:test';
import assert from 'node:assert/strict';

global.window = global.window || {};

const { WeatherHarness } = await import('../src/weather-harness.js');

function resetWindow() {
  global.window = {};
}

test('getCurrentWeather returns a not-available message outside Electron', async () => {
  resetWindow();
  const harness = new WeatherHarness();
  const result = await harness.getCurrentWeather(37.7749, -122.4194);
  assert.equal(result.success, false);
  assert.match(result.message, /not available/i);
});

test('getCurrentWeather delegates to window.jarvisElectron.weather.current and maps the response', async () => {
  resetWindow();
  global.window.jarvisElectron = {
    isElectron: true,
    weather: {
      current: async (lat, lon) => ({
        latitude: lat,
        longitude: lon,
        current: {
          temperature_2m: 18.3,
          apparent_temperature: 17.1,
          relative_humidity_2m: 62,
          wind_speed_10m: 11.4,
          weather_code: 2
        }
      })
    }
  };
  const harness = new WeatherHarness();
  const result = await harness.getCurrentWeather(37.7749, -122.4194);
  assert.equal(result.success, true);
  assert.equal(result.temperatureC, 18);
  assert.equal(result.feelsLikeC, 17);
  assert.equal(result.humidityPct, 62);
  assert.equal(result.windKmph, 11);
  assert.equal(result.description, 'partly cloudy');
});

test('a missing current block resolves to a failure result, not a crash', async () => {
  resetWindow();
  global.window.jarvisElectron = { isElectron: true, weather: { current: async () => ({}) } };
  const harness = new WeatherHarness();
  const result = await harness.getCurrentWeather(1, 2);
  assert.equal(result.success, false);
  assert.match(result.message, /couldn't retrieve/i);
});

test('a thrown IPC call resolves to a failure result', async () => {
  resetWindow();
  global.window.jarvisElectron = { isElectron: true, weather: { current: async () => { throw new Error('nope'); } } };
  const harness = new WeatherHarness();
  const result = await harness.getCurrentWeather(1, 2);
  assert.equal(result.success, false);
  assert.match(result.message, /wasn't able to fetch/i);
});
