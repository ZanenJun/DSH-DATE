#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const anchor = "    const promptText = (roleHint ? roleHint + '\\n\\n' : '')";
const patchedAnchor = "    const promptText = calendarMessageContext + (roleHint ? roleHint + '\\n\\n' : '')";
const marker = '// DSH-CALENDAR-MESSAGE-CONTEXT';
const insertion = String.raw`    // DSH-CALENDAR-MESSAGE-CONTEXT v2 BEGIN
    let calendarMessageContext = '';
    if (kind === 'private' && isOwner && (currentMode === 'closed-agent' && closedAgentPreset === 'calendar-assistant'
      || currentMode === 'chat' && cfg.agentPreset === 'calendar-assistant')) {
      const calendarIds = [event.self_id, event.user_id, event.message_id];
      const calendarValidId = (value, index) => (typeof value === 'number' && Number.isSafeInteger(value)
        || typeof value === 'string' && /^-?(?:0|[1-9]\d*)$/.test(value) && Number.isSafeInteger(Number(value)))
        && (index === 2 || Number(value) > 0);
      const calendarValidTime = Number.isSafeInteger(event.time) && event.time >= 0 && Number.isFinite(new Date(event.time * 1000).getTime());
      const calendarMetadata = calendarIds.every(calendarValidId) && calendarValidTime
        ? {messageId: calendarIds.map(String).join(':'), at: new Date(event.time * 1000).toISOString()}
        : {available: false};
      calendarMessageContext = '【桥接原始消息】' + JSON.stringify(calendarMetadata) + '\n';
    }
    // DSH-CALENDAR-MESSAGE-CONTEXT v2 END
`;

const legacyInsertion = insertion.replace('v2 BEGIN', 'v1 BEGIN').replace('v2 END', 'v1 END')
  .replace("if (kind === 'private' && isOwner && (currentMode === 'closed-agent' && closedAgentPreset === 'calendar-assistant'\n      || currentMode === 'chat' && cfg.agentPreset === 'calendar-assistant')) {",
    "if (kind === 'private' && isOwner && currentMode === 'closed-agent' && closedAgentPreset === 'calendar-assistant') {");

// Only the known ordinary-message intake is changed. No imports or shared
// helpers are required, so the bridge's VM harness remains representative.
export function transformBridgeSource(source) {
  const occurrences = needle => source.split(needle).length - 1;
  if (source.includes(marker)) {
    if (occurrences(marker) === 2 && occurrences(legacyInsertion + patchedAnchor) === 1 && occurrences(anchor) === 0) {
      return {source: source.replace(legacyInsertion, insertion), changed: true};
    }
    if (occurrences(marker) !== 2 || occurrences(insertion + patchedAnchor) !== 1 || occurrences(anchor) !== 0) {
      throw Error('已存在不同版本或不完整的日历消息补丁；未修改桥接。');
    }
    return {source, changed: false};
  }
  const intake = '  async function handleIncoming(kind, id, event, cfg) {';
  const context = "    const roleHint = currentRoleHint();";
  const at = source.indexOf(anchor);
  if (occurrences(intake) !== 1 || occurrences(anchor) !== 1 || at < source.indexOf(intake)
    || source.lastIndexOf(context, at) < source.indexOf(intake)
    || !source.includes("  let closedAgentPreset = '';")
    || !source.includes("  let currentMode = 'chat';")
    || !source.slice(at, at + 450).includes('+ mediaHintFor(key, messageRef, mediaList);')) {
    throw Error('不支持的 qq-bridge 消息入口版本；未修改桥接，请先检查源码兼容性。');
  }
  return {source: source.replace(anchor, insertion + patchedAnchor), changed: true};
}

export async function installQQContext(directory) {
  const root = await fs.realpath(path.resolve(directory));
  const target = path.join(root, 'src', 'bridge.js');
  const stat = await fs.lstat(target);
  if (!stat.isFile()) throw Error('src/bridge.js 必须是普通文件。');
  const original = await fs.readFile(target, 'utf8');
  const transformed = transformBridgeSource(original);
  if (!transformed.changed) return {changed: false, target};
  const backupDirectory = path.join(root, 'state', 'calendar-context-backups');
  await fs.mkdir(backupDirectory, {recursive: true, mode: 0o700});
  const suffix = randomUUID(), backup = path.join(backupDirectory, `bridge.${suffix}.js`);
  const temporary = path.join(root, 'src', `.bridge.calendar-context-${suffix}.tmp`);
  await fs.writeFile(backup, original, {flag: 'wx', mode: 0o600});
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', stat.mode & 0o777);
    await handle.writeFile(transformed.source, 'utf8');
    await handle.sync();
    await handle.close(); handle = null;
    if (await fs.readFile(target, 'utf8') !== original) throw Error('桥接源码在安装期间发生变化；未覆盖，请重新执行。');
    await fs.rename(temporary, target);
    const parent = await fs.open(path.dirname(target), 'r');
    try { await parent.sync(); } finally { await parent.close(); }
    return {changed: true, target, backup};
  } finally {
    await handle?.close();
    await fs.rm(temporary, {force: true});
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw Error('用法：node bin/qq-context-setup.js /path/to/qq-bridge');
    const result = await installQQContext(process.argv[2]);
    console.log(result.changed ? `已添加原始 QQ 消息时间上下文。备份：${result.backup}\n重启 qq-bridge 后生效。` : '原始 QQ 消息上下文补丁已安装，无需修改。');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
