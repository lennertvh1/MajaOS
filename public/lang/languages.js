/* Languages of HomeBaseOS. English is built in: the English text in the code is the key (like gettext).
 * To add a language: copy nl.js to <code>.js, translate the values and add a line below.
 * ui: the dictionary covers the interface. Without it, only the installer is translated, so Settings does not offer it. */
window.TB_LANGS = {
  en: { name: 'English', locale: 'en-GB', ui: true },
  nl: { name: 'Nederlands', locale: 'nl-BE', ui: true },
  fr: { name: 'Français', locale: 'fr-FR', ui: true },
  de: { name: 'Deutsch', locale: 'de-DE', ui: true },
  es: { name: 'Español', locale: 'es-ES', ui: true },
  pt: { name: 'Português', locale: 'pt-PT', ui: true },
  it: { name: 'Italiano', locale: 'it-IT', ui: true },
  pl: { name: 'Polski', locale: 'pl-PL', ui: true },
  zh: { name: '中文', locale: 'zh-CN', ui: true },
  ja: { name: '日本語', locale: 'ja-JP', ui: true },
};
window.TB_LANG = window.TB_LANG || {};
// Load each translation right after this script, so it is there before the page's own scripts run.
Object.keys(window.TB_LANGS).filter((code) => code !== 'en').forEach((code) => document.write('<script src="lang/' + code + '.js"><\/script>'));
