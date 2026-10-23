/* Languages of HomeBaseOS. English is built in: the English text in the code is the key (like gettext).
 * To add a language: copy nl.js to <code>.js, translate the values and add a line below. */
window.TB_LANGS = {
  en: { name: 'English', locale: 'en-GB' },
  nl: { name: 'Nederlands', locale: 'nl-BE' },
};
window.TB_LANG = window.TB_LANG || {};
// Load each translation right after this script, so it is there before the page's own scripts run.
Object.keys(window.TB_LANGS).filter((code) => code !== 'en').forEach((code) => document.write('<script src="lang/' + code + '.js"><\/script>'));
