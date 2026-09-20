import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { toyCity } from './.fixtures.mjs';
const require = createRequire(import.meta.url);
const E = require('../engine.js');

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

test('assign is deterministic, and blind to property insertion order', () => {
  const city = toyCity();
  const a = E.assign(city, city.od), b = E.assign(city, city.od);
  assert.deepEqual(Array.from(a.volumes), Array.from(b.volumes));
  assert.deepEqual(Array.from(a.times), Array.from(b.times));
  // A city parsed from JSON carries its keys in file order. Nothing in the solver
  // may read that order — rebuild every node/link/zone with its keys inserted
  // backwards and the equilibrium has to come out bit-identical.
  const rev = (o) => Object.fromEntries(Object.entries(o).reverse());
  const flipped = Object.assign({}, city, {
    nodes: city.nodes.map(rev), links: city.links.map(rev), zones: city.zones.map(rev),
  });
  const c = E.assign(flipped, flipped.od);
  assert.deepEqual(Array.from(c.volumes), Array.from(a.volumes));
  assert.deepEqual(Array.from(c.times), Array.from(a.times));
});

test('applying then removing every action type restores the baseline exactly', () => {
  const city = toyCity();
  city.nodes[1].control = 'signal'; city.nodes[1].legs = 3;
  city.links[2].builtUp = true;
  city.sites.widenable = [0, 2]; city.sites.turnLane = [1]; city.sites.roundabout = [1];
  city.sites.corridors = [{ id: 'c1', name: 'Main', nodes: [1] }];
  city.sites.parkAndRide = [0]; city.transit.corridorNodeIds = [0];
  city.proposals = [{ id: 'p1', name: 'Bypass', cost: 10e6, newNodes: [], links: [{ from: 0, to: 3, cls: 'primary', lanes: 1, kmh: 80, lengthM: 2500, oneway: false, xy: [[0,0],[3,0]] }] }];
  const base = E.solve(city, []);
  const plans = [
    [{ action: 'lane', site: 0 }], [{ action: 'clear', site: 2 }, { action: 'lane', site: 2 }],
    [{ action: 'turnlane', site: 1 }], [{ action: 'roundabout', site: 1 }],
    [{ action: 'coordinate', site: 'c1' }], [{ action: 'newroad', site: 0 }],
    [{ action: 'frequency', site: null, step: 1 }], [{ action: 'fare', site: null, step: 1 }], [{ action: 'parkride', site: 0 }]
  ];
  for (const p of plans) {
    const withIt = E.solve(city, p);
    assert.notEqual(withIt.delayVehH, base.delayVehH, `plan ${p[0].action} changed nothing`);
    const back = E.solve(city, []);
    assert.equal(back.delayVehH, base.delayVehH);
  }
});

test('pct clamps and rankedValue inverts', () => {
  assert.equal(E.rankedValue(37.44), 1000 - 374);
  assert.equal(E.rankedValue(0), 1000);
  assert.equal(E.pctOf(50, 100), 50);
  assert.equal(E.pctOf(150, 100), 0);     // worse than the baseline floors at 0
  assert.equal(E.pctOf(-50, 100), 100);   // and nothing scores above a clear board
  assert.equal(E.pctOf(100, 0), 0);       // a baseline of zero delay has none to remove
});

test('modeSplit shares are quantized to 1e-6 for cross-engine determinism', () => {
  // Math.exp is implementation-approximated (like Math.pow); this guards against a
  // last-ulp difference between JS engines leaking into the transit share.
  const city = toyCity();
  const world = E.applyPlan(city, []);
  const carOD = E.modeSplit(city, world);
  for (let z = 0; z < city.zones.length; z++) {
    for (let j = 0; j < city.zones.length; j++) {
      const trips = city.od[z][j];
      if (j === z || !(trips > 0)) continue;
      const scaled = (1 - carOD[z][j] / trips) * 1e6;
      assert.ok(Math.abs(scaled - Math.round(scaled)) < 1e-9, `share not quantized to 1e-6: ${scaled}`);
    }
  }
});

test('newroad proposal: array index wins over an authored newNodes.id', () => {
  const city = toyCity();
  city.proposals = [{
    id: 'p1', name: 'X', cost: 6e6,
    newNodes: [{ id: 99, x: 5, y: 5, lat: 0, lon: 0 }],
    links: [{ from: 0, to: -1, cls: 'primary', lanes: 1, kmh: 50, lengthM: 500, oneway: false, xy: [[0,0],[5,5]] }]
  }];
  const world = E.applyPlan(city, [{ action: 'newroad', site: 0 }]);
  const newNodeIndex = city.nodes.length;
  assert.equal(world.city.nodes[newNodeIndex].id, newNodeIndex);
});

test('roundabout supersedes an earlier turnlane multiplier (defense in depth)', () => {
  const city = toyCity();
  city.sites.turnLane = [1]; city.sites.roundabout = [1];
  const withBoth = E.solve(city, [{ action: 'turnlane', site: 1 }, { action: 'roundabout', site: 1 }]);
  const roundaboutOnly = E.solve(city, [{ action: 'roundabout', site: 1 }]);
  assert.equal(withBoth.delayVehH, roundaboutOnly.delayVehH);
});

test('a roundabout ends the junction multiplier whatever order the plan is in', () => {
  // Coordination discounts a signal. A roundabout has no signal, so the discount
  // cannot survive one — and must not survive it only when the player happened to
  // build the roundabout second.
  const mk = () => {
    const c = toyCity();
    c.nodes[1].control = 'signal'; c.nodes[1].legs = 3;
    c.sites.roundabout = [1]; c.sites.corridors = [{ id: 'c1', name: 'Main', nodes: [1] }];
    return c;
  };
  const coordFirst = E.solve(mk(), [{ action: 'coordinate', site: 'c1' }, { action: 'roundabout', site: 1 }]);
  const roundFirst = E.solve(mk(), [{ action: 'roundabout', site: 1 }, { action: 'coordinate', site: 'c1' }]);
  const alone = E.solve(mk(), [{ action: 'roundabout', site: 1 }]);
  assert.equal(coordFirst.delayVehH, roundFirst.delayVehH);
  assert.equal(coordFirst.delayVehH, alone.delayVehH);
});

test('applyPlan skips an unknown corridor id instead of throwing', () => {
  const city = toyCity();
  const base = E.solve(city, []);
  const withUnknown = E.solve(city, [{ action: 'coordinate', site: 'nope' }]);
  assert.equal(withUnknown.delayVehH, base.delayVehH);
});

test('frequency headway derives from baseHeadwayMin, not hardcoded 30/15/10', () => {
  const city = toyCity();
  city.transit.baseHeadwayMin = 20;
  const one = E.applyPlan(city, [{ action: 'frequency', site: null, step: 1 }]);
  assert.equal(one.headwayMin, 10);
  const two = E.applyPlan(city, [{ action: 'frequency', site: null, step: 1 }, { action: 'frequency', site: null, step: 2 }]);
  assert.equal(two.headwayMin, 7); // round(20/3) = 6.67 → 7
});

test('applyPlan rejects an unknown action rather than silently ignoring it', () => {
  const city = toyCity();
  assert.throws(() => E.applyPlan(city, [{ action: 'teleport', site: 0 }]), /unknown action/);
});
