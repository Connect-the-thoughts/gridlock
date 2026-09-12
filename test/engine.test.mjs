import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const E = require('../engine.js');

// Two-route toy: zone A at node 0, zone B at node 3.
// Route 1: 0→1→3 (fast, low cap). Route 2: 0→2→3 (slow, high cap).
export function toyCity() {
  const link = (id, from, to, kmh, lengthM, cap) =>
    ({ id, from, to, name: 'L' + id, cls: 'primary', lanes: 1, oneway: true, kmh, lengthM, capacityVph: cap, builtUp: false, xy: [[0,0],[1,1]] });
  return {
    meta: { id: 'toy', name: 'Toy', population: 1000, budget: 5e6, baselineDelayVehH: 0 },
    nodes: [0,1,2,3].map(i => ({ id: i, x: i, y: 0, lat: 0, lon: 0, legs: 2, control: 'none' })),
    links: [ link(0,0,1,60,1000,500), link(1,1,3,60,1000,500), link(2,0,2,40,1000,2000), link(3,2,3,40,1000,2000) ],
    zones: [ { id: 0, node: 0, name: 'A', productions: 1500, attractions: 0 }, { id: 1, node: 3, name: 'B', productions: 0, attractions: 1500 } ],
    od: [[0, 1500],[0, 0]],
    sites: { widenable: [], turnLane: [], roundabout: [], corridors: [], parkAndRide: [] },
    transit: { baseHeadwayMin: 30, baseFare: 2.5, corridorNodeIds: [] },
    proposals: []
  };
}

test('bpr is monotone in volume and equals t0 at zero flow', () => {
  assert.equal(E.bpr(60, 0, 1000), 60);
  let prev = -1;
  for (let v = 0; v <= 3000; v += 100) { const t = E.bpr(60, v, 1000); assert.ok(t > prev); prev = t; }
});

test('shortestPaths finds the free-flow route', () => {
  const city = toyCity(); const g = E.buildGraph(city);
  const times = g.linkT0.slice(); const pen = new Float64Array(city.nodes.length);
  const r = E.shortestPaths(g, times, pen, 0);
  assert.ok(Math.abs(r.dist[3] - 120) < 1e-9); // 2 × 1000 m at 60 km/h = 120 s
  assert.equal(r.prevLink[3], 1);
});

test('Frank–Wolfe converges to user equilibrium on the two-route toy', () => {
  const city = toyCity();
  const car = city.od;
  const { volumes, times } = E.assign(city, car);
  // Equilibrium: both routes used, travel times within 0.5% of each other.
  const t1 = times[0] + times[1], t2 = times[2] + times[3];
  assert.ok(volumes[0] > 100 && volumes[2] > 100, 'both routes carry flow');
  assert.ok(Math.abs(t1 - t2) / Math.max(t1, t2) < 0.005, `route times ${t1} vs ${t2}`);
  assert.ok(Math.abs(volumes[0] + volumes[2] - 1500) < 1e-6, 'conservation');
});

test('assign is deterministic', () => {
  const city = toyCity();
  const a = E.assign(city, city.od), b = E.assign(city, city.od);
  assert.deepEqual(Array.from(a.volumes), Array.from(b.volumes));
  assert.deepEqual(Array.from(a.times), Array.from(b.times));
});
