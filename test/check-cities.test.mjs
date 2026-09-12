import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const E = require('../engine.js');

// scripts/check-cities.mjs always checks '_tutorial' first (before the pool named
// in index.json), so a fixture whose "_tutorial.json" IS the city under test, with
// an empty pool, exercises the checker against exactly one city per run.
function runChecker(cityJson) {
  const dir = mkdtempSync(join(tmpdir(), 'gridlock-check-'));
  writeFileSync(join(dir, '_tutorial.json'), JSON.stringify(cityJson));
  writeFileSync(join(dir, 'index.json'), '[]');
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'check-cities.mjs')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { GRIDLOCK_CITIES_DIR: dir }),
    encoding: 'utf8'
  });
  rmSync(dir, { recursive: true, force: true });
  return r;
}

const disconnected = {
  meta: { id: '_tutorial', name: 'Disconnected', population: 100, budget: 1000000, baselineDelayVehH: 0 },
  nodes: [0, 1, 2, 3].map((i) => ({ id: i, x: i, y: 0, lat: 0, lon: 0, legs: 1, control: 'none' })),
  links: [
    { id: 0, from: 0, to: 1, name: 'A', cls: 'tertiary', lanes: 1, oneway: false, kmh: 50, lengthM: 500, capacityVph: 900, builtUp: false, xy: [[0, 0], [1, 0]] },
    { id: 1, from: 2, to: 3, name: 'B', cls: 'tertiary', lanes: 1, oneway: false, kmh: 50, lengthM: 500, capacityVph: 900, builtUp: false, xy: [[2, 0], [3, 0]] }
  ],
  zones: [], od: [],
  sites: { widenable: [], turnLane: [], roundabout: [], corridors: [], parkAndRide: [] },
  transit: { baseHeadwayMin: 30, baseFare: 2.5, corridorNodeIds: [] }
};

// A valid, connected, fully zone-reachable toy — mirrors cities/_tutorial.json's shape.
function validToy(baselineDelayVehH) {
  return {
    meta: { id: '_tutorial', name: 'Tutorial Town', population: 5000, budget: 6000000, baselineDelayVehH },
    nodes: [
      { id: 0, x: 0, y: 0, lat: 0, lon: 0, legs: 2, control: 'none' },
      { id: 1, x: 1500, y: 0, lat: 0, lon: 0, legs: 3, control: 'signal' },
      { id: 2, x: 1500, y: 1200, lat: 0, lon: 0, legs: 2, control: 'none' },
      { id: 3, x: 0, y: 1200, lat: 0, lon: 0, legs: 2, control: 'none' }
    ],
    links: [
      { id: 0, from: 0, to: 1, name: 'Main St', cls: 'secondary', lanes: 1, oneway: false, kmh: 50, lengthM: 1500, capacityVph: 1200, builtUp: false, xy: [[0, 0], [1500, 0]] },
      { id: 1, from: 1, to: 2, name: 'Campus Dr', cls: 'tertiary', lanes: 1, oneway: false, kmh: 50, lengthM: 1200, capacityVph: 900, builtUp: true, xy: [[1500, 0], [1500, 1200]] },
      { id: 2, from: 0, to: 3, name: 'River Rd', cls: 'tertiary', lanes: 1, oneway: false, kmh: 40, lengthM: 1200, capacityVph: 900, builtUp: false, xy: [[0, 0], [0, 1200]] },
      { id: 3, from: 3, to: 2, name: 'North Ave', cls: 'tertiary', lanes: 1, oneway: false, kmh: 40, lengthM: 1500, capacityVph: 900, builtUp: false, xy: [[0, 1200], [1500, 1200]] }
    ],
    zones: [
      { id: 0, node: 0, name: 'Homes', productions: 1800, attractions: 100 },
      { id: 1, node: 1, name: 'Downtown', productions: 100, attractions: 1200 },
      { id: 2, node: 2, name: 'Campus', productions: 100, attractions: 700 }
    ],
    od: [[0, 1200, 600], [50, 0, 50], [50, 50, 0]],
    sites: { widenable: [0, 1], turnLane: [1], roundabout: [1], corridors: [], parkAndRide: [] },
    transit: { baseHeadwayMin: 30, baseFare: 2.5, corridorNodeIds: [0, 1] }
  };
}

test('check-cities: disconnected graph exits 1 naming the rule', () => {
  const r = runChecker(disconnected);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /graph not connected/);
});

test('check-cities: wrong stored baseline exits 1 naming the rule', () => {
  const r = runChecker(validToy(0));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /baseline/);
});

test('check-cities: valid toy with the correct baseline exits 0', () => {
  const correctBaseline = E.solve(validToy(0), []).baselineDelayVehH;
  const r = runChecker(validToy(correctBaseline));
  assert.equal(r.status, 0);
  assert.match(r.stdout, /ok/);
});
