const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jarvisElectron', {
  isElectron: true,
  fetchSteamLibrary: (apiKey, steamId) => ipcRenderer.invoke('steam:fetch-owned-games', { apiKey, steamId }),
  epicGetInstalledGames: () => ipcRenderer.invoke('epic:get-installed-games'),
  xboxGetInstalledGames: () => ipcRenderer.invoke('xbox:get-installed-games'),
  xboxLaunchApp: (appId) => ipcRenderer.invoke('xbox:launch-app', { appId }),
  solveMath: (appId, query) => ipcRenderer.invoke('wolfram:solve', { appId, query }),
  weather: {
    current: (lat, lon) => ipcRenderer.invoke('weather:current', { lat, lon })
  },
  maps: {
    findNearby: (lat, lon, query) => ipcRenderer.invoke('maps:find-nearby', { lat, lon, query }),
    getDirections: (lat, lon, destinationQuery) => ipcRenderer.invoke('maps:get-directions', { lat, lon, destinationQuery })
  },
  spotifyResolveTrack: (clientId, clientSecret, query) => ipcRenderer.invoke('spotify:resolve-track', { clientId, clientSecret, query }),
  spotifyAuth: {
    status: () => ipcRenderer.invoke('spotify:auth-status'),
    login: (clientId, clientSecret) => ipcRenderer.invoke('spotify:authorize', { clientId, clientSecret }),
    logout: () => ipcRenderer.invoke('spotify:logout'),
    getLibrary: (clientId, clientSecret) => ipcRenderer.invoke('spotify:get-library', { clientId, clientSecret })
  },
  googleAuth: {
    status: () => ipcRenderer.invoke('google:auth-status'),
    login: (clientId, clientSecret) => ipcRenderer.invoke('google:authorize', { clientId, clientSecret }),
    logout: () => ipcRenderer.invoke('google:logout')
  },
  gmail: {
    listMessages: (clientId, clientSecret, maxResults) => ipcRenderer.invoke('gmail:list-messages', { clientId, clientSecret, maxResults }),
    search: (clientId, clientSecret, query, maxResults) => ipcRenderer.invoke('gmail:search-messages', { clientId, clientSecret, query, maxResults }),
    getMessage: (clientId, clientSecret, id) => ipcRenderer.invoke('gmail:get-message', { clientId, clientSecret, id })
  },
  calendar: {
    listEvents: (clientId, clientSecret, maxResults) => ipcRenderer.invoke('calendar:list-events', { clientId, clientSecret, maxResults }),
    search: (clientId, clientSecret, query, maxResults) => ipcRenderer.invoke('calendar:search-events', { clientId, clientSecret, query, maxResults }),
    createEvent: (clientId, clientSecret, title, description, startISO, endISO) => ipcRenderer.invoke('calendar:create-event', { clientId, clientSecret, title, description, startISO, endISO })
  },
  mcp: {
    fetchWebpage: (url) => ipcRenderer.invoke('mcp:fetch-webpage', { url }),
    browseWebpage: (url, linkText) => ipcRenderer.invoke('mcp:browse-webpage', { url, linkText })
  },
  mic: {
    start: () => ipcRenderer.invoke('mic:start'),
    stop: () => ipcRenderer.invoke('mic:stop'),
    onTranscript: (callback) => {
      const listener = (event, data) => callback(data);
      ipcRenderer.on('mic:transcript', listener);
      return () => ipcRenderer.removeListener('mic:transcript', listener);
    },
    onStatus: (callback) => {
      const listener = (event, data) => callback(data);
      ipcRenderer.on('mic:status', listener);
      return () => ipcRenderer.removeListener('mic:status', listener);
    }
  },
  screen: {
    capturePrimary: () => ipcRenderer.invoke('screen:capture-primary'),
    monitorShow: () => ipcRenderer.invoke('screen:monitor-show'),
    monitorHide: () => ipcRenderer.invoke('screen:monitor-hide')
  },
  update: {
    getVersion: () => ipcRenderer.invoke('update:get-version'),
    getState: () => ipcRenderer.invoke('update:get-state'),
    check: () => ipcRenderer.invoke('update:check'),
    download: () => ipcRenderer.invoke('update:download'),
    install: () => ipcRenderer.invoke('update:install'),
    getChangelog: () => ipcRenderer.invoke('update:get-changelog'),
    onState: (callback) => {
      const listener = (event, data) => callback(data);
      ipcRenderer.on('update:state', listener);
      return () => ipcRenderer.removeListener('update:state', listener);
    }
  }
});
