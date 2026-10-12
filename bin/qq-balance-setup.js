#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const anchor = '    const resolveAtName = async (qq) => {';
const marker = '// DSH-CALENDAR-BALANCE';
const insertion = String.raw`    // DSH-CALENDAR-BALANCE v1 BEGIN
    const calendarBalancePreset = () => currentMode === 'closed-agent' && closedAgentPreset === 'calendar-assistant'
      || currentMode === 'chat' && cfg.agentPreset === 'calendar-assistant';
    const calendarBalanceText = typeof event.message === 'string' ? event.message
      : Array.isArray(event.message) && event.message.length && event.message.every(segment => segment?.type === 'text' && typeof segment.data?.text === 'string')
        ? event.message.map(segment => segment.data.text).join('') : null;
    if (kind === 'private' && String(event.user_id) === String(cfg.ownerQQ ?? '') && String(id) === String(event.user_id)
      && calendarBalancePreset() && ['查余额', '查询余额', '/balance'].includes(calendarBalanceText?.trim())) {
      const balanceEpoch = sessionEpoch, balanceMode = currentMode;
      const balanceOwner = String(event.user_id), balanceBot = String(event.self_id ?? '');
      const balanceCurrent = () => balanceEpoch === sessionEpoch && balanceMode === currentMode && calendarBalancePreset()
        && String(cfg.ownerQQ ?? '') === balanceOwner && isSessionAllowedInCurrentMode(key);
      if (!/^[1-9]\d*$/.test(balanceOwner) || !/^[1-9]\d*$/.test(balanceBot) || balanceOwner === balanceBot) return;
      let balanceText = '余额暂不可查询，请稍后再试；这不表示余额为 0。';
      try {
        const balanceConfigFile = path.resolve(process.env.DSH_CALENDAR_CONFIG || path.join(dshHomeDir(), 'calendar-agent', 'config.json'));
        const balanceConfig = JSON.parse(fs.readFileSync(balanceConfigFile, 'utf8'));
        if (String(balanceConfig.onebot?.ownerQQ ?? '') !== balanceOwner || String(balanceConfig.onebot?.botQQ ?? '') !== balanceBot) return;
        const balancePort = balanceConfig.port ?? 3217;
        if (!Number.isInteger(balancePort) || balancePort < 1 || balancePort > 65535 || typeof balanceConfig.dataDir !== 'string' || !balanceConfig.dataDir) throw new Error('Invalid calendar configuration');
        const balanceToken = fs.readFileSync(path.join(path.resolve(path.dirname(balanceConfigFile), balanceConfig.dataDir), 'access-token'), 'utf8').trim();
        if (balanceToken.length < 32 || /[\r\n]/.test(balanceToken)) throw new Error('Invalid calendar access token');
        const balanceResponse = await fetch('http://127.0.0.1:' + balancePort + '/v1/balance/refresh', {
          method: 'POST', headers: {Authorization: 'Bearer ' + balanceToken, 'Content-Type': 'application/json'},
          body: '{}', redirect: 'error', signal: AbortSignal.timeout(20000)
        });
        if (!balanceResponse.ok) throw new Error('Calendar balance unavailable');
        const balanceResult = await balanceResponse.json();
        if (typeof balanceResult.text !== 'string' || !balanceResult.text.trim() || balanceResult.text.length > 2000) throw new Error('Invalid balance response');
        balanceText = balanceResult.text;
      } catch { /* Operational failure is answered directly, never as a zero balance or an Agent turn. */ }
      if (!balanceCurrent()) return;
      const balanceSendGuard = captureSendGuard(key);
      // Recheck the command's epoch and permissions when the shared send queue
      // reaches this reply; a reset during another outbound send cancels it.
      sendChain = sendChain.then(async () => {
        if (!balanceCurrent()) return;
        balanceSendGuard();
        await withTimeout(bot.sendPrivateMessage(Number(balanceOwner), text(escapeCqText(redactKnownTokensOnly(balanceText)))), SEND_TIMEOUT_MS, 'QQ余额查询回复');
      }).catch(() => { log('余额查询回复未发送；未转交 Agent。'); }).then(() => sleep(cfg.sendDelayMs));
      await sendChain;
      return;
    }
    // DSH-CALENDAR-BALANCE v1 END
`;

export function transformBridgeSource(source) {
  const count = value => source.split(value).length - 1;
  if (source.includes(marker)) {
    if (count(marker) !== 2 || count(insertion + anchor) !== 1 || count(anchor) !== 1) throw Error('已存在不同版本或不完整的余额补丁；未修改桥接。');
    return {source, changed: false};
  }
  const intake = '  async function handleIncoming(kind, id, event, cfg) {';
  const at = source.indexOf(anchor), before = source.slice(source.indexOf(intake), at);
  if (count(intake) !== 1 || count(anchor) !== 1 || at < source.indexOf(intake)
    || !before.includes('if (!modeAllowed(key, kind, id, cfg, currentMode)) {')
    || !before.includes('      return;') || before.includes('voiceInput.transcribe')
    || !source.includes("  let closedAgentPreset = '';") || !source.includes('  let sessionEpoch = 0;')
    || !source.includes('function dshHomeDir() {') || !source.includes('  function captureSendGuard(key) {')
    || !source.includes('  let sendChain = Promise.resolve();')) throw Error('不支持的 qq-bridge 消息入口版本；未修改桥接。');
  return {source: source.replace(anchor, insertion + anchor), changed: true};
}

export async function installQQBalance(directory) {
  const root = await fs.realpath(path.resolve(directory)), target = path.join(root, 'src', 'bridge.js');
  const stat = await fs.lstat(target);
  if (!stat.isFile()) throw Error('src/bridge.js 必须是普通文件。');
  const original = await fs.readFile(target, 'utf8'), transformed = transformBridgeSource(original);
  if (!transformed.changed) return {changed: false, target};
  const backupDirectory = path.join(root, 'state', 'calendar-balance-backups');
  await fs.mkdir(backupDirectory, {recursive: true, mode: 0o700});
  const suffix = randomUUID(), backup = path.join(backupDirectory, `bridge.${suffix}.js`);
  const temporary = path.join(root, 'src', `.bridge.calendar-balance-${suffix}.tmp`);
  await fs.writeFile(backup, original, {flag: 'wx', mode: 0o600});
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', stat.mode & 0o777);
    await handle.writeFile(transformed.source, 'utf8'); await handle.sync(); await handle.close(); handle = null;
    if (await fs.readFile(target, 'utf8') !== original) throw Error('桥接源码在安装期间发生变化；未覆盖，请重新执行。');
    await fs.rename(temporary, target);
    const parent = await fs.open(path.dirname(target), 'r');
    try { await parent.sync(); } finally { await parent.close(); }
    return {changed: true, target, backup};
  } finally { await handle?.close(); await fs.rm(temporary, {force: true}); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw Error('用法：node bin/qq-balance-setup.js /path/to/qq-bridge');
    const result = await installQQBalance(process.argv[2]);
    console.log(result.changed ? `已安装 QQ 直接查询余额。备份：${result.backup}\n重启 qq-bridge 后生效。` : 'QQ 余额查询补丁已安装，无需修改。');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
