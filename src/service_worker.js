const kDefaultSettings = require('./default-settings');

// =============================================================================
// GitHub Copilot OAuth Device Flow
// =============================================================================
// GitHub OAuth App credentials (public – device flow requires no secret)
const GITHUB_CLIENT_ID = 'Iv1.b507a08c87ecfe98'; // GitHub Copilot editor integration client id
const COPILOT_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token';

// Start device flow: returns { device_code, user_code, verification_uri, interval, expires_in }
async function githubStartDeviceFlow() {
  const resp = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, scope: 'read:user' }),
  });
  if (!resp.ok) throw new Error(`Device flow start failed: ${resp.status}`);
  return resp.json();
}

// Poll for OAuth token after user enters device code
async function githubPollDeviceToken(deviceCode, interval) {
  const delay = ms => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 60; i++) {
    await delay((interval || 5) * 1000);
    const resp = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });
    const data = await resp.json();
    if (data.access_token) return data.access_token;
    if (data.error === 'access_denied') throw new Error('Access denied by user');
    // authorization_pending or slow_down: keep polling
  }
  throw new Error('Device flow timed out');
}

// Exchange GitHub OAuth token for a short-lived Copilot API token
async function fetchCopilotToken(oauthToken) {
  const resp = await fetch(COPILOT_TOKEN_URL, {
    headers: {
      'Authorization': `token ${oauthToken}`,
      'Editor-Version': 'vscode/1.85.0',
      'Editor-Plugin-Version': 'copilot-chat/0.12.0',
      'User-Agent': 'GithubCopilot/1.155.0',
    },
  });
  const body = await resp.text();
  if (!resp.ok) throw new Error(`Copilot 토큰 발급 실패 (${resp.status}): ${body}`);
  const data = JSON.parse(body);
  if (!data.token) throw new Error(`Copilot 토큰 없음. 응답: ${body}`);
  return { token: data.token, expiresAt: data.expires_at };
}

// Get a valid Copilot token, refreshing if needed
async function getValidCopilotToken(settings) {
  const now = Math.floor(Date.now() / 1000);
  if (settings.githubCopilotToken && settings.githubCopilotTokenExpiry > now + 60) {
    return settings.githubCopilotToken;
  }
  if (!settings.githubOAuthToken) throw new Error('GitHub 로그인이 필요합니다 (플러그인 설정 확인)');
  const { token, expiresAt } = await fetchCopilotToken(settings.githubOAuthToken);
  settings.githubCopilotToken = token;
  settings.githubCopilotTokenExpiry = expiresAt;
  saveSettings(settings);
  dispatchSettings(settings);
  return token;
}

// Proxy a Copilot Chat Completions request from the content script
async function handleCopilotTranslate(settings, messages) {
  const copilotToken = await getValidCopilotToken(settings);
  const model = settings.aiModel || 'gpt-4o-mini';
  const resp = await fetch('https://api.githubcopilot.com/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${copilotToken}`,
      'Content-Type': 'application/json',
      'Copilot-Integration-Id': 'vscode-chat',
      'Editor-Version': 'vscode/1.85.0',
      'Editor-Plugin-Version': 'copilot-chat/0.12.0',
      'User-Agent': 'GithubCopilot/1.155.0',
    },
    body: JSON.stringify({ model, messages, temperature: 0.2 }),
  });
  const body = await resp.text();
  if (!resp.ok) throw new Error(`Copilot API 오류 (${resp.status}) model=${model}: ${body}`);
  return JSON.parse(body);
}

// return true if valid; otherwise return false
function validateSettings(settings) {
  const keys = Object.keys(kDefaultSettings);
  return keys.every(key => (key in settings));
}

const loadSettings = async () => {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(['settings'], function (result) {
      console.log('Loaded: settings=', result.settings);
      if (result.settings && validateSettings(result.settings)) {
        resolve(result.settings)
      }
      else {
        saveSettings(kDefaultSettings);
        resolve(kDefaultSettings);
      }
    });
  });
};

function saveSettings(settings) {
  // hack to update opacity for existing users
  settings.primaryImageOpacity = 1
  settings.primaryTextOpacity = 1
  settings.secondaryImageOpacity = 1
  settings.secondaryTextOpacity = 1
  chrome.storage.local.set({ settings: settings }, () => {
    console.log('Settings: saved into local storage', settings);
  });
}

// TODO: revisit this logic. 
// The port is ephemeral in manifest v3, so keeping a map of ports is probably not useful.
let gExtPorts = {}; // tabId -> msgPort; for config dispatching
function dispatchSettings(settings) {
  try {
    const keys = Object.keys(gExtPorts);
    keys.map(k => gExtPorts[k]).forEach(port => {
      try {
        port.postMessage({ settings: settings });
      }
      catch (err) {
        console.error('Error: cannot dispatch settings,', err);
      }
    });
  } catch (err) { }
}

function saturateActionIconForTab(tabId) {
  try {
    // v2
    chrome.browserAction.setIcon({
      tabId: tabId,
      path: {
        '16': 'icon16.png',
        '32': 'icon32.png',
      },
    });
  } catch (err) {
    // v3
    chrome.action.setIcon({
      path: {
        '16': 'icon16.png',
        '32': 'icon32.png',
      },
    });
  }
}

function desaturateActionIconForTab(tabId) {
  try {
    // v2
    chrome.browserAction.setIcon({
      tabId: tabId,
      path: {
        '16': 'icon16-gray.png',
        '32': 'icon32-gray.png',
      },
    });
  } catch (err) {
    // v3
    chrome.action.setIcon({
      path: {
        '16': 'icon16-gray.png',
        '32': 'icon32-gray.png',
      },
    });
  }
}

// connected from target website (our injected agent)
async function handleExternalConnection(port) {
  const tabId = port.sender && port.sender.tab && port.sender.tab.id;
  if (!tabId) return;

  gExtPorts[tabId] = port;
  console.log(`Connected: ${tabId} (tab)`);

  var gSettings = await loadSettings();
  port.postMessage({ settings: gSettings });

  port.onMessage.addListener(msg => {
    if (msg.settings) {
      console.log('Received from injected agent: settings=', msg.settings);
      let settings = Object.assign({}, gSettings);
      settings = Object.assign(settings, msg.settings);
      if (!validateSettings(settings)) {
        gSettings = Object.assign({}, kDefaultSettings);
        port.postMessage({ settings: gSettings });
      }
      else {
        gSettings = settings;
      }
      saveSettings(gSettings);
      dispatchSettings(gSettings);
    }
    else if (msg.startPlayback) {
      console.log('Saturate icon')
      saturateActionIconForTab(tabId);
    }
    else if (msg.stopPlayback) {
      console.log('Desaturate icon')
      desaturateActionIconForTab(tabId);
    }
    else {

    }
  });

  port.onDisconnect.addListener(() => {
    delete gExtPorts[tabId];
    console.log(`Disconnected: ${tabId} (tab)`);
  });
}

// connected from our pop-up page
async function handleInternalConnection(port) {
  const portName = port.name;
  console.log(`Connected: ${portName} (internal)`);

  port.onDisconnect.addListener(() => {
    console.log(`Disconnected: ${portName} (internal)`);
  });

  if (portName !== 'settings') return;

  var gSettings = await loadSettings();
  console.log('Dispatching settings to pop-up', gSettings);
  port.postMessage({ settings: gSettings });

  port.onMessage.addListener(msg => {
    // this logic is a mess, a leftover from when gSettings was a global variable
    // TODO: could use a refactor
    if (!msg.settings) {
      gSettings = Object.assign({}, kDefaultSettings);
      port.postMessage({ settings: gSettings });
    }
    else {
      console.log('Received: settings=', msg.settings);
      let settings = Object.assign({}, gSettings);
      settings = Object.assign(settings, msg.settings);
      if (!validateSettings(settings)) {
        gSettings = Object.assign({}, kDefaultSettings);
        port.postMessage({ settings: gSettings });
      }
      else {
        gSettings = settings;
      }
    }
    saveSettings(gSettings);
    dispatchSettings(gSettings);
  });
}

// handle connections from target website and our pop-up
if (BROWSER !== 'firefox') {
  chrome.runtime.onConnectExternal.addListener(
    port => handleExternalConnection(port));

  chrome.runtime.onConnect.addListener(
    port => handleInternalConnection(port));
}
else {
  // Firefox: either from website (injected agent) or pop-up are all "internal"
  chrome.runtime.onConnect.addListener(port => {
    if (port.sender && port.sender.tab) {
      handleExternalConnection(port);
    }
    else {
      handleInternalConnection(port);
    }
  });
}

// =============================================================================
// Message-based API (for settings popup, used for device flow + copilot proxy)
// =============================================================================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    const gSettings = await loadSettings();

    // --- GitHub device flow: step 1 ---
    if (msg.action === 'github_start_device_flow') {
      try {
        const data = await githubStartDeviceFlow();
        sendResponse({ ok: true, data });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
      return;
    }

    // --- GitHub device flow: step 2 (poll) ---
    if (msg.action === 'github_poll_device_token') {
      try {
        const oauthToken = await githubPollDeviceToken(msg.deviceCode, msg.interval);
        // save oauth token, clear stale copilot token, auto-switch provider
        gSettings.githubOAuthToken = oauthToken;
        gSettings.githubCopilotToken = '';
        gSettings.githubCopilotTokenExpiry = 0;
        gSettings.aiProvider = 'copilot';
        gSettings.aiModel = 'gpt-5-mini';
        saveSettings(gSettings);
        dispatchSettings(gSettings);
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
      return;
    }

    // --- GitHub logout ---
    if (msg.action === 'github_logout') {
      gSettings.githubOAuthToken = '';
      gSettings.githubCopilotToken = '';
      gSettings.githubCopilotTokenExpiry = 0;
      saveSettings(gSettings);
      dispatchSettings(gSettings);
      sendResponse({ ok: true });
      return;
    }

    // --- Copilot translation proxy (called from content.js relay) ---
    if (msg.action === 'copilot_translate') {
      try {
        const result = await handleCopilotTranslate(gSettings, msg.messages);
        sendResponse({ ok: true, data: result });
      } catch (e) {
        console.error('[Copilot translate error]', e.message);
        sendResponse({ ok: false, error: e.message });
      }
      return;
    }

    sendResponse({ ok: false, error: 'Unknown action' });
  })();
  return true; // keep message channel open for async response
});
