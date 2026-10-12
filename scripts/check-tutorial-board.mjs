// Fence for the tutorial level's board claims (game.js TUT_STEPS). Recomputes,
// from the real engine, every fact the step copy leans on:
//   step 0  "Red means over capacity. Tap the red road."  -> Main St (link 0) is
//           the ONLY link over capacity at baseline.
//   step 1  "buy it a lane ... watch the delay meter"      -> a lane on link 0 is
//           eligible, affordable, and moves delay removed above zero.
//   step 2  Submit scores the plan as a positive percent.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const E = require('../engine.js');
const A = require('../actions.js');
const dir = new URL('../cities/', import.meta.url);
const city = JSON.parse(readFileSync(new URL('_tutorial.json', dir), 'utf8'));
try { city.proposals = JSON.parse(readFileSync(new URL('_tutorial.proposals.json', dir), 'utf8')); }
catch { city.proposals = []; }
const TUT_LINK = 0;
let bad = 0;
const fail = (m) => { console.error('FAIL ' + m); bad++; };

const base = E.solve(city, []);
const g = base.world.graph;
const ratio = new Float64Array(city.links.length);
g.arcs.forEach((a, i) => { if (base.arcRatio[i] > ratio[a.link]) ratio[a.link] = base.arcRatio[i]; });
const over = [...ratio].map((r, i) => (r > 1 ? i : -1)).filter((i) => i >= 0);
if (over.length !== 1 || over[0] !== TUT_LINK) fail('over-capacity links at baseline are [' + over + '], expected only [' + TUT_LINK + ']');

const ok = A.eligible(city, [], 'lane', TUT_LINK);
if (ok !== true) fail('lane on Main St not eligible: ' + ok);
const item = { action: 'lane', site: TUT_LINK };
const cost = A.costOf(city, item);
if (!(cost <= city.meta.budget)) fail('lane costs ' + cost + ' > budget ' + city.meta.budget);
const after = E.solve(city, [item]);
if (!(after.pct > 0)) fail('lane on Main St removes ' + after.pct + '% of delay, expected > 0');
if (!(city.meta.budget - cost >= 0)) fail('budget cannot cover the lane');

if (bad) process.exit(1);
console.log('tutorial board claims hold: Main St only red, lane affordable, delay removed ' + after.pct.toFixed(1) + '%');
