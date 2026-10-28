import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// main.cjs needs a live Electron runtime, so check its source instead:
// every register*Ipc() defined there must also be called at startup.
// A defined-but-never-called registrar leaves its ipcRenderer.invoke
// channels with no handler (e.g. registerFilesIpc, which broke Memory).
const mainSrc = readFileSync(
  fileURLToPath(new URL('../electron/main.cjs', import.meta.url)),
  'utf8'
);

const defined = [...mainSrc.matchAll(/^function (register\w*Ipc)\s*\(/gm)].map((m) => m[1]);

test('main.cjs defines IPC registrars', () => {
  assert.ok(defined.includes('registerFilesIpc'));
});

for (const name of defined) {
  test(`${name} is called at startup`, () => {
    assert.ok(
      new RegExp(`^\\s+${name}\\(\\);`, 'm').test(mainSrc),
      `${name} is defined in electron/main.cjs but never called`
    );
  });
}
