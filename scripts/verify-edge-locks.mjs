import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

// No function is executed and no provider/environment secrets are needed.
const update = process.argv.includes('--update');
const root = path.resolve('supabase/functions');
let checked = 0;
for (const entry of readdirSync(root, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
  const files = readdirSync(path.join(root, entry.name));
  if (!files.includes('index.ts')) continue;
  if (!files.includes('deno.json')) throw Error(`Missing per-function config: ${entry.name}`);
  const result = spawnSync(process.env.DENO_BIN || 'deno', [
    'cache', '--config', path.join(root, entry.name, 'deno.json'),
    `--frozen=${!update}`, path.join(root, entry.name, 'index.ts'),
  ], { stdio: 'inherit', windowsHide: true, timeout: 120000 });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
  console.log(`Verified Edge dependency lock: ${entry.name}`);
  checked++;
}
console.log(`Verified ${checked} frozen Edge dependency graphs${update ? ' (explicit lock update)' : ''}.`);
