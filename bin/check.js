import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
for (const dir of ['src','bin','test']) for (const name of await fs.readdir(dir)) {
  if (!name.endsWith('.js')) continue;
  const result = spawnSync(process.execPath,['--check',`${dir}/${name}`],{stdio:'inherit'});
  if(result.status!==0) process.exit(result.status ?? 1);
}
console.log('JavaScript syntax OK');
