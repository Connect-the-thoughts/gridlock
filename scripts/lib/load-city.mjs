import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// Overridable for tests: GRIDLOCK_CITIES_DIR points the checker at a fixture
// directory instead of the real cities/ tree. Default is unchanged.
const CITIES_DIR = process.env.GRIDLOCK_CITIES_DIR || join(ROOT, 'cities');
export function loadCity(id) {
  const city = JSON.parse(readFileSync(join(CITIES_DIR, id + '.json'), 'utf8'));
  const pp = join(CITIES_DIR, id + '.proposals.json');
  city.proposals = existsSync(pp) ? JSON.parse(readFileSync(pp, 'utf8')) : [];
  return city;
}
export function poolIds() { return JSON.parse(readFileSync(join(CITIES_DIR, 'index.json'), 'utf8')); }
export { ROOT, CITIES_DIR };
