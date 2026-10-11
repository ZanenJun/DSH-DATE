import fs from 'node:fs/promises';
import path from 'node:path';
import { readConfig } from './config.js';
export async function localClient(configFile) {
  const config = await readConfig(configFile);
  const token = (await fs.readFile(path.join(config.dataDir, 'access-token'), 'utf8')).trim();
  return async (route, input) => {
    const response = await fetch(`http://127.0.0.1:${config.port}/v1/${route}`, {
      method: input === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: input === undefined ? undefined : JSON.stringify(input), signal: AbortSignal.timeout(route === 'reminder-preview' || route.startsWith('icloud/') ? 130000 : 15000), redirect: 'error'
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? `Calendar API ${response.status}`);
    return data;
  };
}
