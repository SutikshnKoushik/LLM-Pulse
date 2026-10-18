import assert from 'node:assert/strict';
import fs from 'node:fs';

const index = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const main = fs.readFileSync(new URL('../electron/main.js', import.meta.url), 'utf8');
assert.match(index, /<html lang="en">/, 'HTML starts with English for the first render');
assert.match(app, /const DEFAULT_LANGUAGE = "en";/);
assert.match(app, /const FALLBACK_LANGUAGE = "en";/);
assert.match(app, /Fresh installs start in English regardless of the browser\/OS locale/);
assert.doesNotMatch(app, /const languages = navigator\.languages\?\.length \? navigator\.languages/,
  'browser locale must not override the English fresh-install default');
assert.match(main, /const NOTIFICATION_FALLBACK_LANGUAGE = "en";/);
console.log('default language tests passed');
