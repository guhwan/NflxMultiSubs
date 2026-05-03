const console = require('./console');


window.addEventListener('load', () => {
  const scriptsToInject = ['nflxmultisubs.min.js'];
  scriptsToInject.forEach(scriptName => {
    const scriptElem = document.createElement('script');
    scriptElem.setAttribute('type', 'text/javascript');
    scriptElem.setAttribute('src', chrome.runtime.getURL(scriptName));
    scriptElem.setAttribute('id', chrome.runtime.id)
    document.head.appendChild(scriptElem);
    console.log(`Injected: ${scriptName}`);
  });
});


// Firefox: the target website (our injected agent) cannot connect to extensions
// directly, thus we need to relay the connection in this content script.
let gMsgPort;
window.addEventListener('message', evt => {
  if (!evt.data || evt.data.namespace !== 'nflxmultisubs') return;

  if (evt.data.action === 'connect') {
    if (!gMsgPort) {
      gMsgPort = browser.runtime.connect(browser.runtime.id);
      gMsgPort.onMessage.addListener(msg => {
        if (msg.settings) {
          window.postMessage({
            namespace: 'nflxmultisubs',
            action: 'apply-settings',
            settings: msg.settings,
          }, '*');
        }
      });
    }
  }
  else if (evt.data.action === 'disconnect') {
    if (gMsgPort) {
      gMsgPort.disconnect();
      gMsgPort = null;
      gMsgPort.disconnect();
    }
  }
  else if (evt.data.action === 'update-settings') {
    if (gMsgPort) {
      if (evt.data.settings) {
        gMsgPort.postMessage({ settings: evt.data.settings });
      }
    }
  }
  else if (evt.data.action === 'startPlayback') {
    if (gMsgPort) {
      gMsgPort.postMessage({ startPlayback: 1 });
    }
  }
  else if (evt.data.action === 'stopPlayback') {
    if (gMsgPort) {
      gMsgPort.postMessage({ stopPlayback: 1 });
    }
  }
  else if (evt.data.action === 'cache_read') {
    chrome.storage.local.get([evt.data.key], result => {
      window.postMessage({
        namespace: 'nflxmultisubs',
        action: 'cache_read_response',
        reqId: evt.data.reqId,
        value: result[evt.data.key] || null,
      }, '*');
    });
  }
  else if (evt.data.action === 'cache_write') {
    chrome.storage.local.set({ [evt.data.key]: evt.data.value });
  }
  else if (evt.data.action === 'copilot_translate') {
    const { reqId, messages } = evt.data;
    // Content scripts can fetch external URLs directly (host_permissions cover the Copilot API)
    // Load settings from storage then call Copilot API directly — avoids service worker sleeping issues
    chrome.storage.local.get(['settings'], async (result) => {
      const settings = result.settings || {};
      try {
        // Get or refresh Copilot token
        let copilotToken = settings.githubCopilotToken;
        const now = Math.floor(Date.now() / 1000);
        if (!copilotToken || (settings.githubCopilotTokenExpiry || 0) <= now + 60) {
          if (!settings.githubOAuthToken) throw new Error('GitHub \ub85c\uadf8\uc778\uc774 \ud544\uc694\ud569\ub2c8\ub2e4');
          const tokenResp = await fetch('https://api.github.com/copilot_internal/v2/token', {
            headers: {
              'Authorization': `token ${settings.githubOAuthToken}`,
              'Editor-Version': 'vscode/1.85.0',
              'Editor-Plugin-Version': 'copilot-chat/0.12.0',
              'User-Agent': 'GithubCopilot/1.155.0',
            },
          });
          const tokenBody = await tokenResp.text();
          if (!tokenResp.ok) throw new Error(`\ud1a0\ud070 \ubc1c\uae09 \uc2e4\ud328 (${tokenResp.status}): ${tokenBody}`);
          const tokenData = JSON.parse(tokenBody);
          if (!tokenData.token) throw new Error(`Copilot \ud1a0\ud070 \uc5c6\uc74c: ${tokenBody}`);
          copilotToken = tokenData.token;
          // Persist refreshed token
          chrome.storage.local.set({ settings: Object.assign(settings, {
            githubCopilotToken: copilotToken,
            githubCopilotTokenExpiry: tokenData.expires_at,
          })});
        }

        const model = settings.aiModel || 'gpt-4o-mini';
        const apiResp = await fetch('https://api.githubcopilot.com/chat/completions', {
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
        const apiBody = await apiResp.text();
        if (!apiResp.ok) throw new Error(`Copilot API \uc624\ub958 (${apiResp.status}) model=${model}: ${apiBody}`);
        const data = JSON.parse(apiBody);
        window.postMessage({ namespace: 'nflxmultisubs', action: 'copilot_translate_response', reqId, ok: true, data }, '*');
      } catch(e) {
        window.postMessage({ namespace: 'nflxmultisubs', action: 'copilot_translate_response', reqId, ok: false, error: e.message }, '*');
      }
    });
  }
}, false);
