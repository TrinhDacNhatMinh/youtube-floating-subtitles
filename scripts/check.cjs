const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const checked = new Set();
const defaultMessages = JSON.parse(fs.readFileSync(path.join(root, '_locales', manifest.default_locale, 'messages.json'), 'utf8'));
for (const locale of ['en', 'vi']) {
  const messages = JSON.parse(fs.readFileSync(path.join(root, '_locales', locale, 'messages.json'), 'utf8'));
  for (const key of Object.keys(defaultMessages)) {
    if (!messages[key]?.message) throw new Error(`Missing ${locale} translation: ${key}`);
  }
}
for (const match of JSON.stringify(manifest).matchAll(/__MSG_(\w+)__/g)) {
  if (!defaultMessages[match[1]]) throw new Error(`Missing manifest translation: ${match[1]}`);
}

function resource(file, from = root) {
  const absolute = path.resolve(from, file);
  if (!absolute.startsWith(root + path.sep) || !fs.statSync(absolute).isFile()) throw new Error(`Invalid resource: ${file}`);
  return absolute;
}

function javascript(file) {
  if (checked.has(file)) return;
  checked.add(file);
  const code = fs.readFileSync(file, 'utf8');
  for (const match of code.matchAll(/\bt\(['"](\w+)['"]/g)) {
    if (!defaultMessages[match[1]]) throw new Error(`Missing translation in ${file}: ${match[1]}`);
  }
  new vm.Script(code, { filename: path.relative(root, file) });
  // Worker imports are relative to the worker; injected files use the extension root.
  for (const match of code.matchAll(/importScripts\(([^)]+)\)/g)) {
    for (const quoted of match[1].matchAll(/['"]([^'"]+)['"]/g)) javascript(resource(quoted[1], path.dirname(file)));
  }
  for (const match of code.matchAll(/files:\s*\[([^\]]+)\]/g)) {
    for (const quoted of match[1].matchAll(/['"]([^'"]+)['"]/g)) javascript(resource(quoted[1]));
  }
}

const pages = new Set([manifest.action.default_popup, manifest.options_ui.page]);
for (const page of pages) {
  const file = resource(page);
  const html = fs.readFileSync(file, 'utf8');
  for (const match of html.matchAll(/data-i18n(?:-title|-aria-label)?="(\w+)"/g)) {
    if (!defaultMessages[match[1]]) throw new Error(`Missing HTML translation: ${match[1]}`);
  }
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const asset = resource(match[1], path.dirname(file));
    if (asset.endsWith('.js')) javascript(asset);
  }
}
for (const entry of manifest.content_scripts) for (const file of entry.js) javascript(resource(file));
javascript(resource(manifest.background.service_worker));
if (manifest.manifest_version !== 3) throw new Error('Expected Manifest V3');
console.log(`Manifest, ${pages.size} HTML page and ${checked.size} JavaScript files checked, including relative asset/import/injection paths.`);
