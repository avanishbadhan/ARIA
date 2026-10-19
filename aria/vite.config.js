import { defineConfig } from 'vite';

// Proxies Steam Web API calls through Vite's own dev server so the browser
// never has to make a cross-origin request (and doesn't depend on a
// third-party CORS proxy like allorigins.win, which is unreliable).
export default defineConfig({
  // Relative asset paths — Electron's packaged app loads dist/index.html via
  // the file:// protocol, where Vite's default absolute base ("/assets/...")
  // fails to resolve at all (only affects the packaged build; the dev server
  // serves over http:// and isn't affected).
  base: './',
  server: {
    proxy: {
      '/steam-api': {
        target: 'https://api.steampowered.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/steam-api/, '')
      },
      '/wolfram-api': {
        target: 'https://api.wolframalpha.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/wolfram-api/, '')
      }
    }
  }
});
