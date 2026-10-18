import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'public/workspace.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public/styles.css'), 'utf8');
assert.match(html, /id="workspacePaletteDialog"/);
assert.match(html, /id="workspacePaletteBtn"/);
assert.match(html, /id="focusModeBtn"/);
assert.match(html, /id="densityModeBtn"/);
assert.match(html, /src="\/workspace\.js" defer/);
for (const id of ['refresh', 'settings', 'focus', 'compact', 'glass', 'motion', 'providers', 'codex-resets', 'quota-integrity', 'token-history', 'live', 'pricing', 'about']) {
  assert.match(js, new RegExp(`id: "${id}"`), `command palette includes ${id}`);
}
assert.match(js, /event\.ctrlKey \|\| event\.metaKey/);
assert.match(js, /llmUsage\.workspace\.focus/);
assert.match(js, /llmUsage\.workspace\.compact/);
assert.match(js, /llmUsage\.workspace\.glass/);
assert.match(js, /llmUsage\.workspace\.motion/);
assert.match(css, /backdrop-filter:\s*blur\(14px\) saturate\(132%\)/);
assert.match(css, /data-glass="off"/);
assert.match(css, /workspace-focus-mode/);
assert.match(css, /workspace-compact/);
assert.match(css, /data-motion="reduced"/);
const i18nDir = path.join(root, 'public/i18n');
for (const file of fs.readdirSync(i18nDir).filter((name) => name.endsWith('.json'))) {
  const locale = JSON.parse(fs.readFileSync(path.join(i18nDir, file), 'utf8'));
  for (const key of ['openPalette', 'paletteShortcut', 'focusMode', 'focusShortcut', 'compactMode']) {
    assert.equal(typeof locale.workspace?.[key], 'string', `${file} missing workspace.${key}`);
  }
}
console.log('workspace UI tests passed');
