import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export function loadCity(id) {
  const city = JSON.parse(readFileSync(join(ROOT, 'cities', id + '.json'), 'utf8'));
  const pp = join(ROOT, 'cities', id + '.proposals.json');
  city.proposals = existsSync(pp) ? JSON.parse(readFileSync(pp, 'utf8')) : [];
  return city;
}
export function poolIds() { return JSON.parse(readFileSync(join(ROOT, 'cities', 'index.json'), 'utf8')); }
export { ROOT };
