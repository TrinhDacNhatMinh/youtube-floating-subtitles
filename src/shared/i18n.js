(() => {
  'use strict';
  const locale = /^vi(?:[-_]|$)/i.test(chrome.i18n.getUILanguage()) ? 'vi' : 'en';
  const t = (key, value) => chrome.i18n.getMessage(key, value === undefined ? [] : String(value)) || key;
  function localize(root) {
    for (const element of root.querySelectorAll('[data-i18n]')) element.textContent = t(element.dataset.i18n);
    for (const attribute of ['title', 'aria-label']) {
      for (const element of root.querySelectorAll('[data-i18n-' + attribute + ']')) {
        element.setAttribute(attribute, t(element.getAttribute('data-i18n-' + attribute)));
      }
    }
  }
  globalThis.SubtitleI18n = { locale, t, localize };
})();
