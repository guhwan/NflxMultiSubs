const kDefaultSettings = {
  upperBaselinePos: 0.15,
  lowerBaselinePos: 0.85,
  primaryImageScale: 0.75,
  primaryImageOpacity: 1,
  primaryTextScale: 0.95,
  primaryTextOpacity: 1,
  primaryTextColor: "#ffffff",
  secondaryImageScale: 0.5,
  secondaryImageOpacity: 1,
  secondaryTextScale: 1.0,
  secondaryTextStroke: 2.0,
  secondaryTextOpacity: 1,
  secondaryTextColor: "#ffffff",
  // secondaryLanguageMode valid values are:
  //    'disabled',
  //    'audio' (use audio language),
  //    'last' (use last used language)
  secondaryLanguageMode: 'audio',
  // bcp47 code of the last used language
  secondaryLanguageLastUsed: '',
  secondaryLanguageLastUsedIsCaption: false,

  // AI Translation settings
  // aiProvider valid values: 'gemini', 'openai', 'copilot'
  aiProvider: 'gemini',
  aiApiKey: '',
  // model name per provider (e.g. 'gemini-2.0-flash', 'gpt-4o-mini')
  aiModel: 'gemini-2.0-flash',
  // GitHub Copilot OAuth token (long-lived, stored after device flow)
  githubOAuthToken: '',
  // GitHub Copilot short-lived API token (auto-refreshed)
  githubCopilotToken: '',
  // Unix timestamp (seconds) when githubCopilotToken expires
  githubCopilotTokenExpiry: 0,
};

module.exports = kDefaultSettings;
