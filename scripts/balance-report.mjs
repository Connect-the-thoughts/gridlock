#!/usr/bin/env node
// Is this city a puzzle? Greedy delay-per-dollar solver + the three gates (spec §6):
//   1. ceiling            — the best greedy plan removes ≤ 60% of the delay
//   2. diversity          — ≥ 2 of the three STRATEGIES (transit / signals / roads) can be
//                           banned outright and greedy still lands within 5 points
//   3. no dominant action — the best SINGLE action is worth ≤ a third of the greedy plan
// Exits 1 if any gate fails.
import { createRequire } from 'node:module';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadCity, poolIds } from './lib/load-city.mjs';
const require = createRequire(import.meta.url);
const E = require('../engine.js'), A = require('../actions.js');

/* Progress goes to stderr: a full report is minutes of equilibrium solving and a
   silent terminal looks like a hang. stdout stays exactly the report. */
const note = (s) => { if (process.env.GRIDLOCK_QUIET !== '1') process.stderr.write(s); };

/* One plan's delay. Same maths as the engine's solveWorld, but WITHOUT E.solve's
   re-derivation of the baseline — that number is a constant per city and the
   greedy search calls this thousands of times. */
function evaluate(city, plan) {
  const w = E.applyPlan(city, plan);
  const carOD = E.modeSplit(city, w);
  const r = E.assign(w.city, carOD, {
    graph: w.graph,
    penaltyOf: (i, vol) => E.nodePenaltySeconds(w.control[i], w.city.nodes[i].legs, w.nodeMult[i], vol),
  });
  const carrying = new Set();
  for (let i = 0; i < w.graph.arcs.length; i++) if (r.volumes[i] > 1e-9) carrying.add(w.graph.arcs[i].link);
  return { delay: E.delayOf(w.graph, r), carrying };
}

/* A candidate is one PICK. 'lane+clear' is the compound the built-up links need:
   Clear land buys nothing on its own, so the widening and the land it needs are
   one unit of choice with one combined price. */
function expand(c) {
  return c.action === 'lane+clear'
    ? [{ action: 'clear', site: c.site }, { action: 'lane', site: c.site }]
    : [{ action: c.action, site: c.site, step: c.step }];
}
function costOf(city, c) { return expand(c).reduce((s, it) => s + A.costOf(city, it), 0); }

/* THE THREE STRATEGIES. Gate 2 asks a question about the PLAYER's options, not about
   individual actions: can someone who refuses to touch the roads, or who doesn't
   believe in buses, still build a good plan? Excluding one action at a time only ever
   measured whether the solver had a near-tied substitute for it — which it always
   does, one link over. Banning a whole category is the real question. */
const CATEGORIES = {
  transit: ['frequency', 'fare', 'parkride'],
  signals: ['turnlane', 'coordinate'],
  roads:   ['lane', 'clear', 'roundabout', 'newroad']
};
/* A ban is by ACTION, so it has to see through the lane+clear compound. */
function banned(bans, c) { return expand(c).some((it) => bans.has(it.action)); }

/* Eligibility of a compound is checked against the plan it would be appended to,
   item by item — Add a lane is only legal once its Clear land is in front of it. */
function ok(city, plan, c) {
  const tmp = plan.slice();
  for (const it of expand(c)) {
    if (A.eligible(city, tmp, it.action, it.site) !== true) return false;
    tmp.push(it);
  }
  return true;
}

function candidates(city, plan, carrying) {
  const out = [];
  const push = (action, site, step) => { const c = { action, site, step }; if (ok(city, plan, c)) out.push(c); };
  for (const l of city.sites.widenable) {
    // A link carrying no flow is a PROVABLE no-op for Add a lane: BPR returns t0 at
    // zero volume whatever the capacity, so the equilibrium cannot move. Skipping
    // those is exact, not a heuristic.
    if (carrying && !carrying.has(l)) continue;
    push(city.links[l].builtUp && !plan.some((p) => p.action === 'clear' && p.site === l) ? 'lane+clear' : 'lane', l);
  }
  for (const nd of city.sites.turnLane) push('turnlane', nd);
  for (const nd of city.sites.roundabout) push('roundabout', nd);
  for (const c of city.sites.corridors) push('coordinate', c.id);
  city.proposals.forEach((_, i) => push('newroad', i));
  for (const z of city.sites.parkAndRide) push('parkride', z);
  push('frequency', null, plan.filter((p) => p.action === 'frequency').length + 1);
  push('fare', null, plan.filter((p) => p.action === 'fare').length + 1);
  return out;
}

function greedy(city, budget, baseline, bans = new Set()) {
  const plan = [], picks = [];
  let spent = 0, st = evaluate(city, plan), cur = E.pctOf(st.delay, baseline);
  for (;;) {
    let best = null;
    for (const c of candidates(city, plan, st.carrying)) {
      if (banned(bans, c)) continue;
      const cost = costOf(city, c);
      if (spent + cost > budget) continue;
      const p = E.pctOf(evaluate(city, [...plan, ...expand(c)]).delay, baseline);
      const gain = (p - cur) / (cost / 1e6);
      if (!best || gain > best.gain) best = { c, p, cost, gain };
    }
    if (!best || best.p <= cur + 1e-9) break;
    plan.push(...expand(best.c)); picks.push(best.c); spent += best.cost; cur = best.p;
    st = evaluate(city, plan);
    note(`    +${label(best.c)} @ ${describe(city, best.c)} → ${cur.toFixed(2)}% ($${(spent / 1e6).toFixed(1)}M)\n`);
  }
  return { plan, picks, spent, pct: cur };
}

function label(c) {
  return c.action === 'lane+clear' ? 'Clear land + Add a lane' : A.BY_ID[c.action].label;
}
function describe(city, p) {
  if (p.action === 'lane' || p.action === 'clear' || p.action === 'lane+clear') return city.links[p.site].name;
  if (p.action === 'turnlane' || p.action === 'roundabout') {
    return 'node ' + p.site + ' (' + ((city.links.find((L) => L.from === p.site || L.to === p.site) || {}).name || '?') + ')';
  }
  if (p.action === 'newroad') return city.proposals[p.site].name;
  if (p.action === 'parkride') return city.zones[p.site].name;
  if (p.action === 'coordinate') {
    const c = city.sites.corridors.find((x) => x.id === p.site);
    return p.site + (c ? ' — ' + c.name : '');
  }
  return 'citywide step ' + (p.step || 1);
}

/* Child mode: one category-banned plan, printed as JSON. The three banned runs are
   independent greedy searches of the same size as the main one, so the parent farms
   them out across cores instead of walking them one at a time. */
if (process.env.GRIDLOCK_BAN) {
  const city = loadCity(process.argv[2]);
  const alt = greedy(city, city.meta.budget, city.meta.baselineDelayVehH,
                     new Set(CATEGORIES[process.env.GRIDLOCK_BAN]));
  process.stdout.write(JSON.stringify({ pct: alt.pct, n: alt.picks.length, spent: alt.spent }));
  process.exit(0);
}

function runBanned(id, cat) {
  return new Promise((resolve, reject) => {
    const cp = fork(fileURLToPath(import.meta.url), [id],
      { env: { ...process.env, GRIDLOCK_BAN: cat, GRIDLOCK_QUIET: '1' },
        stdio: ['ignore', 'pipe', 'inherit', 'ipc'] });
    let out = '';
    cp.stdout.on('data', (d) => { out += d; });
    cp.on('exit', (code) => {
      if (code !== 0) return reject(new Error(`no-${cat} run exited ${code}`));
      note(`  no-${cat}: done\n`);
      resolve(JSON.parse(out));
    });
  });
}

let failed = false;
for (const id of (process.argv[2] ? [process.argv[2]] : poolIds())) {
  const city = loadCity(id), budget = city.meta.budget;
  const baseline = city.meta.baselineDelayVehH;
  note(`${id}: greedy…\n`);
  const g = greedy(city, budget, baseline);
  const base = evaluate(city, []);
  const singles = candidates(city, [], base.carrying)
    .filter((c) => costOf(city, c) <= budget)
    .map((c) => ({ c, pct: E.pctOf(evaluate(city, expand(c)).delay, baseline) }));
  singles.sort((a, b) => b.pct - a.pct || (a.c.action + a.c.site).localeCompare(b.c.action + b.c.site));
  const topSingle = singles[0];
  /* Gate 2: ban each whole strategy in turn and see whether the city still yields a
     plan within 5 points. Two survivors means at least three genuinely different ways
     to play the city — the thing the gate is actually for. */
  const cats = Object.keys(CATEGORIES);
  note(`${id}: ${cats.length} category-banned plans…\n`);
  const raw = await Promise.all(cats.map((cat) => runBanned(id, cat)));
  const alts = cats.map((cat, i) => ({ cat, ...raw[i], counts: raw[i].pct >= g.pct - 5 }));
  const diverse = alts.filter((a) => a.counts).length;
  const gate1 = g.pct <= 60, gate2 = diverse >= 2, gate3 = topSingle.pct <= g.pct / 3;
  console.log(`\n${city.meta.name}: budget $${(budget / 1e6).toFixed(1)}M, baseline ${baseline.toFixed(1)} veh·h`);
  console.log(`  greedy: ${g.pct.toFixed(1)}% with ${g.picks.length} actions ($${(g.spent / 1e6).toFixed(1)}M)`);
  for (const p of g.picks) console.log(`    - ${label(p)} @ ${describe(city, p)}  $${(costOf(city, p) / 1e6).toFixed(1)}M`);
  console.log(`  top single: ${label(topSingle.c)} @ ${describe(city, topSingle.c)} → ${topSingle.pct.toFixed(1)}%`);
  console.log('  runners-up: ' + singles.slice(1, 4).map((s) => `${label(s.c)} @ ${describe(city, s.c)} ${s.pct.toFixed(1)}%`).join(' · '));
  console.log(`  strategies that still work when banned: ${diverse} of ${cats.length}` +
              ` (within 5 points of ${g.pct.toFixed(1)}%)`);
  for (const a of alts) {
    console.log(`    ${a.counts ? '✓' : '✗'} no ${a.cat} (${CATEGORIES[a.cat].join(', ')}): ` +
                `${a.pct.toFixed(1)}% in ${a.n} actions ($${(a.spent / 1e6).toFixed(1)}M)`);
  }
  console.log(`  gates: ceiling ${gate1 ? 'ok' : 'FAIL'} (${g.pct.toFixed(1)} ≤ 60) · ` +
              `diversity ${gate2 ? 'ok' : 'FAIL'} (${diverse} ≥ 2) · ` +
              `no-dominant-action ${gate3 ? 'ok' : 'FAIL'} (${topSingle.pct.toFixed(1)} ≤ ${(g.pct / 3).toFixed(1)})`);
  if (!(gate1 && gate2 && gate3)) failed = true;
}
process.exit(failed ? 1 : 0);
