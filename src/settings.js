let settings = {};
let primaryPicker, secondaryPicker;

if (BROWSER === 'firefox') {
  const Picker = require('vanilla-picker');

  primaryPicker = new Picker({
    popup: 'bottom',
    color: '#ffffff',
    alpha: false,
    editor: false
  });

  secondaryPicker = new Picker({
    popup: 'top',
    color: '#ffffff',
    alpha: false,
    editor: false
  });
}

const port = chrome.runtime.connect({ name: 'settings' });
port.onMessage.addListener((msg) => {
  settings = msg.settings || settings;
  renderActiveSettings();

  primaryPicker?.setColor(settings.primaryTextColor || "#ffffff", true);
  secondaryPicker?.setColor(settings.secondaryTextColor || "#ffffff", true);
  console.log('Settings received:', settings);
});

// -----------------------------------------------------------------------------

const minimumFontScale = 0.3;
const maximumFontScale = 2.5;

const layoutPresets = [
  { // compact
    upperBaselinePos: 0.20,
    lowerBaselinePos: 0.80,
  },
  { // moderate (default)
    upperBaselinePos: 0.15,
    lowerBaselinePos: 0.85,
  },
  { // ease
    upperBaselinePos: 0.10,
    lowerBaselinePos: 0.90,
  },
];

const secondaryLanguagePresets = [
  {
    secondaryLanguageMode: 'disabled',
  },
  {
    secondaryLanguageMode: 'audio',
  },
  {
    secondaryLanguageMode: 'last',
  }
];


function uploadSettings() {
  port.postMessage({ settings: settings });
}

function resetSettings() {
  port.postMessage({ settings: null });
}

function renderActiveSettings() {
  if (document.readyState !== 'complete') return;

  // clear all
  [].forEach.call(document.querySelectorAll('.active'), elem => {
    elem.classList.remove('active');
  });

  let elem;

  // layout
  const layoutId = layoutPresets.findIndex(k => (k.lowerBaselinePos === settings.lowerBaselinePos));
  if (layoutId !== -1) {
    elem = document.querySelector(`.settings-layout > div[data-id="${layoutId}"]`);
    elem && elem.classList.add('active');
  }
  // primary font size
  document.getElementById('primary-font-indicator').style.scale = settings.primaryTextScale * 0.8;
  
  // primary font color
  document.getElementById('primary-color').value = settings.primaryTextColor || "#ffffff";

  // secondary font size
  document.getElementById('secondary-font-indicator').style.scale = settings.secondaryTextScale * 0.8;

  // secondary font color
  document.getElementById('secondary-color').value = settings.secondaryTextColor || "#ffffff";

  // secondary language
  const secondaryLanguageId = secondaryLanguagePresets.findIndex(k => (k.secondaryLanguageMode === settings.secondaryLanguageMode));
  if (secondaryLanguageId !== -1) {
    elem = document.querySelector(`.settings-secondary-lang > div[data-id="${secondaryLanguageId}"]`);
    elem && elem.classList.add('active');

    if(settings.secondaryLanguageLastUsed)
      document.getElementById('langcode').innerHTML = settings.secondaryLanguageLastUsed.split('-')[0] // only display language code, not script tag (eg: zh not zh-Hans)
  }

  // AI settings
  renderAiSettings();
}

function updateLayout(layoutId) {
  if (layoutId < 0 || layoutId >= layoutPresets.length) return;

  settings = Object.assign(settings, layoutPresets[layoutId]);
  uploadSettings();
  renderActiveSettings();
}

function updatePrimaryFontSize(action) {
  if (action === "+") {
    settings.primaryTextScale = Math.min(maximumFontScale, settings.primaryTextScale + 0.1);
  } else if (action === "-"){
    settings.primaryTextScale = Math.max(minimumFontScale, settings.primaryTextScale - 0.1);
  } else return;

  settings.primaryImageScale = 0.6 * settings.primaryTextScale;
  uploadSettings();
  renderActiveSettings();
}

function updateSecondaryFontSize(action) {
  if (action === "+") {
    settings.secondaryTextScale = Math.min(maximumFontScale, settings.secondaryTextScale + 0.1);
  } else if (action === "-"){
    settings.secondaryTextScale = Math.max(minimumFontScale, settings.secondaryTextScale - 0.1);
  } else return;

  settings.secondaryImageScale = 0.6 * settings.secondaryTextScale;

  uploadSettings();
  renderActiveSettings();
}

function updatePrimaryColor(color) {
  settings = Object.assign(settings, {primaryTextColor: color});
  uploadSettings();
  renderActiveSettings();
}

function updateSecondaryColor(color) {
  settings = Object.assign(settings, {secondaryTextColor: color});
  uploadSettings();
  renderActiveSettings();
}

function updateSecondaryLanguage(secondaryLanguage){
  if (secondaryLanguage < 0 || secondaryLanguage >= secondaryLanguagePresets.length) return;

  settings = Object.assign(settings, secondaryLanguagePresets[secondaryLanguage]);
  uploadSettings();
  renderActiveSettings();
}


function renderVersion() {
  let elem = document.querySelector('#version');
  if (elem) {
    elem.textContent = VERSION;
  }
}

// =============================================================================
// AI Settings
// =============================================================================

const AI_PROVIDER_MODELS = {
  gemini: 'gemini-2.0-flash',
  openai: 'gpt-4o-mini',
  copilot: 'gpt-4o',
};

const AI_APIKEY_HINTS = {
  gemini: 'Get your key at aistudio.google.com/app/apikey',
  openai: 'Get your key at platform.openai.com/api-keys',
  copilot: '',
};

function renderAiSettings() {
  const provider = settings.aiProvider || 'gemini';

  // Provider buttons
  document.querySelectorAll('.ai-provider-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.provider === provider);
  });

  // Show/hide API key section
  const apikeySection = document.getElementById('ai-apikey-section');
  const copilotSection = document.getElementById('ai-copilot-section');
  if (provider === 'copilot') {
    apikeySection.style.display = 'none';
    copilotSection.style.display = '';
    renderCopilotStatus();
  } else {
    apikeySection.style.display = '';
    copilotSection.style.display = 'none';
    document.getElementById('ai-apikey-label').textContent =
      provider === 'openai' ? 'OpenAI API Key' : 'Gemini API Key';
    const keyField = document.getElementById('ai-api-key');
    keyField.value = settings.aiApiKey || '';
    keyField.placeholder = provider === 'openai' ? 'sk-...' : 'AIza...';
    document.getElementById('ai-apikey-hint').textContent = AI_APIKEY_HINTS[provider] || '';
  }

  // Model
  const modelField = document.getElementById('ai-model');
  modelField.value = settings.aiModel || AI_PROVIDER_MODELS[provider] || '';
  modelField.placeholder = AI_PROVIDER_MODELS[provider] || '';

  // Hide model input for Copilot (server decides)
  document.getElementById('ai-model-section').style.display = provider === 'copilot' ? 'none' : '';
}

function renderCopilotStatus() {
  const statusEl = document.getElementById('copilot-auth-status');
  const loginBtn = document.getElementById('copilot-login-btn');
  const logoutBtn = document.getElementById('copilot-logout-btn');

  if (settings.githubOAuthToken) {
    statusEl.innerHTML = '<span class="ai-ok">✅ GitHub Copilot 연결됨</span>';
    loginBtn.style.display = 'none';
    logoutBtn.style.display = '';
  } else {
    statusEl.innerHTML = '<span class="ai-warn">⚠️ 로그인이 필요합니다</span>';
    loginBtn.style.display = '';
    logoutBtn.style.display = 'none';
  }
}

async function startCopilotLogin() {
  const loginBtn = document.getElementById('copilot-login-btn');
  const deviceFlowDiv = document.getElementById('copilot-device-flow');
  const pollStatus = document.getElementById('copilot-poll-status');

  loginBtn.disabled = true;
  loginBtn.textContent = 'Starting...';

  chrome.runtime.sendMessage({ action: 'github_start_device_flow' }, async (resp) => {
    if (!resp || !resp.ok) {
      alert('GitHub 로그인 시작 실패: ' + (resp?.error || 'Unknown error'));
      loginBtn.disabled = false;
      loginBtn.textContent = 'Login with GitHub';
      return;
    }

    const { device_code, user_code, verification_uri, interval } = resp.data;

    // Show device code UI
    deviceFlowDiv.style.display = '';
    document.getElementById('copilot-verify-url').href = verification_uri;
    document.getElementById('copilot-verify-url').textContent = verification_uri;
    document.getElementById('copilot-user-code').textContent = user_code;
    pollStatus.textContent = 'Waiting for authorization...';

    // Poll for token
    chrome.runtime.sendMessage({ action: 'github_poll_device_token', deviceCode: device_code, interval }, (pollResp) => {
      deviceFlowDiv.style.display = 'none';
      loginBtn.disabled = false;
      loginBtn.textContent = 'Login with GitHub';

      if (!pollResp || !pollResp.ok) {
        alert('GitHub 인증 실패: ' + (pollResp?.error || 'Unknown error'));
        return;
      }

      // ✅ 로그인 성공 → provider를 copilot으로 자동 전환
      settings = Object.assign(settings, {
        aiProvider: 'copilot',
        aiModel: 'gpt-4o',
      });
      uploadSettings();
      // settings updated in service worker, reload
      port.postMessage({ settings: null }); // trigger reload from storage
    });
  });
}

function copilotLogout() {
  chrome.runtime.sendMessage({ action: 'github_logout' }, () => {
    port.postMessage({ settings: null }); // trigger reload from storage
  });
}


window.addEventListener('load', evt => {
  renderVersion();
  renderActiveSettings();
  console.log('Settings page loaded');

  // handle click events
  // ---------------------------------------------------------------------------
  const layouts = document.querySelectorAll('.settings-layout > div');
  [].forEach.call(layouts, div => {
    const layoutId = parseInt(div.getAttribute('data-id'));
    div.addEventListener('click', evt => updateLayout(layoutId), false);
  });

  document.getElementById("primary-plus").addEventListener('click', () => updatePrimaryFontSize("+"));
  document.getElementById("primary-minus").addEventListener('click', () => updatePrimaryFontSize("-"));

  document.getElementById("secondary-plus").addEventListener('click', () => updateSecondaryFontSize("+"));
  document.getElementById("secondary-minus").addEventListener('click', () => updateSecondaryFontSize("-"));

  const primaryColorField = document.getElementById('primary-color');
  primaryColorField.onchange = evt => {
    updatePrimaryColor(evt.target.value);
  }

  primaryPicker?.setOptions({
    parent: document.getElementById('primary-color-ff'),
    onChange: color => {
      updatePrimaryColor(color.hex.slice(0, 7));
    }
  });

  const secondaryColorField = document.getElementById('secondary-color');
  secondaryColorField.onchange = evt => {
    updateSecondaryColor(evt.target.value);
  }

  secondaryPicker?.setOptions({
    parent: document.getElementById('secondary-color-ff'),
    onChange: color => {
      updateSecondaryColor(color.hex.slice(0, 7));
    }
  });

  const secondaryLanguage = document.querySelectorAll('.settings-secondary-lang > div');
  [].forEach.call(secondaryLanguage, div => {
    const languageId = parseInt(div.getAttribute('data-id'));
    div.addEventListener('click', evt => updateSecondaryLanguage(languageId), false);
  });

  const btnReset = document.getElementById('btnReset');
  btnReset.addEventListener('click', evt => {
    resetSettings();
  }, false);

  // AI settings event handlers
  // ---------------------------------------------------------------------------
  document.querySelectorAll('.ai-provider-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const provider = btn.dataset.provider;
      settings = Object.assign(settings, {
        aiProvider: provider,
        aiModel: AI_PROVIDER_MODELS[provider] || settings.aiModel,
      });
      uploadSettings();
      renderActiveSettings();
    });
  });

  document.getElementById('ai-apikey-save').addEventListener('click', () => {
    const key = document.getElementById('ai-api-key').value.trim();
    settings = Object.assign(settings, { aiApiKey: key });
    uploadSettings();
    const btn = document.getElementById('ai-apikey-save');
    btn.textContent = 'Saved!';
    setTimeout(() => { btn.textContent = 'Save'; }, 1500);
  });

  document.getElementById('ai-model-save').addEventListener('click', () => {
    const model = document.getElementById('ai-model').value.trim();
    settings = Object.assign(settings, { aiModel: model });
    uploadSettings();
    const btn = document.getElementById('ai-model-save');
    btn.textContent = 'Saved!';
    setTimeout(() => { btn.textContent = 'Save'; }, 1500);
  });

  document.getElementById('copilot-login-btn').addEventListener('click', startCopilotLogin);
  document.getElementById('copilot-logout-btn').addEventListener('click', copilotLogout);
});
