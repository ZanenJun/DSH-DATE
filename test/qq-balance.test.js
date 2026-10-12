import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {transformBridgeSource, installQQBalance} from '../bin/qq-balance-setup.js';

const fixture = `// unrelated CLI edit
function dshHomeDir() {}
  let closedAgentPreset = '';
  let sessionEpoch = 0;
  let sendChain = Promise.resolve();
  function captureSendGuard(key) {}
  async function handleIncoming(kind, id, event, cfg) {
    const key = convKey(kind, id);
    if (!modeAllowed(key, kind, id, cfg, currentMode)) {
      return;
    }
    const resolveAtName = async (qq) => {};
    const voice = await voiceInput.transcribe(event);
  }
`;

test('balance installer targets authorized intake before transcription and preserves existing edits', () => {
  const result = transformBridgeSource(fixture);
  assert.equal(result.changed, true);
  assert.ok(result.source.startsWith('// unrelated CLI edit\n'));
  assert.ok(result.source.indexOf('DSH-CALENDAR-BALANCE') < result.source.indexOf('voiceInput.transcribe'));
  assert.deepEqual(transformBridgeSource(result.source), {source: result.source, changed: false});
  assert.throws(() => transformBridgeSource(fixture + fixture), /不支持/);
  assert.throws(() => transformBridgeSource(fixture.replace('modeAllowed(key, kind, id, cfg, currentMode)', 'true')), /不支持/);
  assert.throws(() => transformBridgeSource(result.source.replace('v1 BEGIN', 'v9 BEGIN')), /不同版本/);
});

test('balance installer creates a private complete backup, updates atomically and does not duplicate patches', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'calendar-qq-balance-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  await fs.mkdir(path.join(root, 'src'));
  const target = path.join(root, 'src', 'bridge.js');
  await fs.writeFile(target, fixture);
  const result = await installQQBalance(root);
  assert.equal(await fs.readFile(result.backup, 'utf8'), fixture);
  assert.equal((await fs.stat(result.backup)).mode & 0o777, 0o600);
  assert.equal(await fs.readFile(target, 'utf8'), transformBridgeSource(fixture).source);
  assert.equal((await installQQBalance(root)).changed, false);
  assert.equal((await fs.readdir(path.dirname(result.backup))).length, 1);
});
