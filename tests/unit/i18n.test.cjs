const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const catalogs = Object.fromEntries(['en', 'vi'].map(locale => [locale, JSON.parse(fs.readFileSync(`_locales/${locale}/messages.json`, 'utf8'))]));

function translation(uiLanguage, pageLanguage) {
  const catalog = catalogs[/^vi(?:[-_]|$)/i.test(uiLanguage) ? 'vi' : 'en'];
  const context = { navigator: { language: pageLanguage }, chrome: { i18n: {
    getUILanguage: () => uiLanguage,
    getMessage: (key, value) => {
      const entry = catalog[key];
      if (!entry) return '';
      return entry.message.replace(/\$([a-z_]+)\$/gi, (_, name) => {
        const placeholder = entry.placeholders?.[name.toLowerCase()];
        return placeholder?.content === '$1' ? String(value) : '';
      });
    }
  } } };
  vm.runInNewContext(fs.readFileSync('src/shared/i18n.js', 'utf8'), context);
  return context.SubtitleI18n;
}
test('English and Vietnamese catalogs have matching messages and placeholders', () => {
  assert.deepEqual(Object.keys(catalogs.en).sort(), Object.keys(catalogs.vi).sort());
  for (const key of Object.keys(catalogs.en)) {
    for (const catalog of Object.values(catalogs)) assert.ok(catalog[key].message.trim(), key);
    assert.deepEqual(catalogs.en[key].placeholders, catalogs.vi[key].placeholders, key);
  }
});
test('UI language selects regional Vietnamese and English independently of page language', () => {
  for (const locale of ['vi', 'vi-VN', 'VI_vn']) assert.equal(translation(locale, 'en-US').t('start'), catalogs.vi.start.message);
  for (const locale of ['en', 'en-US', 'en-GB']) assert.equal(translation(locale, 'vi-VN').t('start'), catalogs.en.start.message);
  assert.equal(translation('fr-FR', 'vi-VN').locale, 'en');
});
test('dynamic status preserves video titles and error details as plain text', () => {
  for (const locale of ['en', 'vi']) {
    const i18n = translation(locale);
    const title = '<Video tiếng Việt & English>';
    assert.ok(i18n.t('followingStatus', title).includes(title));
    assert.ok(i18n.t('connectionError', 'Network error').includes('Network error'));
  }
});
