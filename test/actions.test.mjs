import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { toyCity } from './.fixtures.mjs';
const require = createRequire(import.meta.url);
const A = require('../actions.js');

test('eligibility: each rule has a yes and a no', () => {
  const c = toyCity();
  c.links[0].builtUp = true; c.sites.widenable = [0, 2]; c.sites.turnLane = [1]; c.sites.roundabout = [1];
  c.sites.corridors = [{ id: 'c1', name: 'Main', nodes: [1] }]; c.sites.parkAndRide = [0];
  c.proposals = [{ id: 'p1', name: 'X', cost: 1e6, newNodes: [], links: [] }];
  assert.equal(A.eligible(c, [], 'lane', 0), 'needs Clear land first');
  assert.equal(A.eligible(c, [{ action: 'clear', site: 0 }], 'lane', 0), true);
  assert.equal(A.eligible(c, [], 'lane', 1), 'not widenable');
  assert.equal(A.eligible(c, [], 'clear', 0), true);
  // Link 2 is widenable but not built up: the frontage is already there to widen into.
  assert.equal(A.eligible(c, [], 'clear', 2), 'nothing to clear');
  assert.equal(A.eligible(c, [], 'turnlane', 1), true);
  assert.equal(A.eligible(c, [{ action: 'roundabout', site: 1 }], 'turnlane', 1), 'a roundabout has no signal');
  assert.equal(A.eligible(c, [], 'roundabout', 1), true);
  assert.equal(A.eligible(c, [], 'roundabout', 0), 'not suitable');
  assert.equal(A.eligible(c, [{ action: 'turnlane', site: 1 }], 'roundabout', 1), 'remove the turn lane first');
  assert.equal(A.eligible(c, [], 'coordinate', 'c1'), true);
  assert.equal(A.eligible(c, [], 'coordinate', 'zz'), 'not a signal corridor');
  assert.equal(A.eligible(c, [], 'newroad', 0), true);
  assert.equal(A.eligible(c, [], 'newroad', 9), 'no such proposal');
  assert.equal(A.eligible(c, [{ action: 'frequency' }, { action: 'frequency' }], 'frequency', null), 'maxed out');
  assert.equal(A.eligible(c, [{ action: 'fare' }, { action: 'fare' }], 'fare', null), 'maxed out');
  assert.equal(A.eligible(c, [], 'parkride', 0), true);
  assert.equal(A.eligible(c, [], 'parkride', 1), 'no transit corridor here');
});

// The price list is a balance instrument (scripts/balance-report.mjs is what rules on
// it), so pin the numbers as literals here: a price move has to be a deliberate edit
// in two places, not a silent side effect of touching actions.js.
test('costs: the price list, per unit and per km; fee is 5% of budget', () => {
  const c = toyCity();                                    // every toy link is exactly 1 km
  assert.equal(A.costOf(c, { action: 'lane', site: 0 }), 4e6);      // $4M/km, rounded to $100k
  assert.equal(A.costOf(c, { action: 'clear', site: 0 }), 2e6);     // $2M/km
  assert.equal(A.costOf(c, { action: 'turnlane', site: 1 }), 2e6);
  assert.equal(A.costOf(c, { action: 'roundabout', site: 1 }), 2e6);
  assert.equal(A.costOf(c, { action: 'coordinate', site: 'c1' }), 1e6);
  assert.equal(A.costOf(c, { action: 'frequency', site: null, step: 1 }), 3e6);
  assert.equal(A.costOf(c, { action: 'frequency', site: null, step: 2 }), 3e6);
  assert.equal(A.costOf(c, { action: 'fare', site: null, step: 1 }), 2e6);
  assert.equal(A.costOf(c, { action: 'fare', site: null, step: 2 }), 4e6);
  assert.equal(A.costOf(c, { action: 'parkride', site: 0 }), 2e6);
  // 5e6 × 5% = $250k sits on a rounding tie; JS Math.round rounds .5 up, so $300k.
  assert.equal(A.consultantFee(c), 3e5);
});

// A short link must not price a widening at pocket change: the floors are what keep
// a 100 m stub from being a free win the greedy solver hoovers up.
test('costs: short links hit the lane/clear floors', () => {
  const c = toyCity();
  c.links[0].lengthM = 120;                               // 0.12 km
  assert.equal(A.costOf(c, { action: 'lane', site: 0 }), A.COST.laneMin);
  assert.equal(A.costOf(c, { action: 'clear', site: 0 }), A.COST.clearMin);
});
