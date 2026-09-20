/* ═══════════════════════════════════════════════════════════════════
   GRIDLOCK — a real city at rush hour, a fixed budget, one plan.

   RULES        Spend the budget on lanes, turn lanes, roundabouts, signal
                coordination, new roads, buses, fares and park-and-ride.
                Nothing is scored until you Submit. Everything before that
                is free to add and free to take back.

   METRIC       % of peak-hour delay removed, to one decimal. moreIsBetter,
                so the RANKED value is Coat Check's inversion —
                `1000 − round(pct·10)` — which sorts ascending on the server
                while every surface a player reads shows the raw `pct%`.
                epoch 1, single lane 'daily'.

   NO HINT TERM IN THE METRIC (spec §4.5, Ruling 11). The Consultant is
                priced in the game's own BUDGET: each fact costs 5% of it
                (GridlockActions.consultantFee), which is money that can no
                longer buy a roundabout. The charge is therefore ALREADY in
                the score, by way of the plan the player could not afford —
                so no `hints` reaches recordHistory, the winboard meta or
                presentResults, and no "+Nh" mark is ever composed. The
                count lives in two places only: the HUD counter the shared
                hint control owns, and the resume snapshot (tally + charged
                keys), so a reload cannot re-charge for a fact already paid
                for.

   CLOCKLESS    The metric is delay removed, not time. No arcade-clock.

   Style: single classic IIFE, `var`, 'use strict' — matches the arcade.
   ═══════════════════════════════════════════════════════════════════ */
(function () {
'use strict';

var GAME = 'gridlock';
var LB_EPOCH = 1;
/* SINGLE LANE. A city is a board, not a difficulty — there are no tiers, so
   there is no #diffRow, no arcade-difficulty.js, and no `difficulties` on the
   leaderboard modal. Coat Check's convention: the lane string is 'daily'. */
var LANE = 'daily';
/* The rotation era, in ArcadeDailySeed.dailyDayNumber's SHARED-EPOCH space
   (NOT the local unix day number, which is ~20700 and would put the era in the
   future). Day 256 = 2026-09-13, Gridlock's first day. Grow the city pool by
   starting a NEW era — a new ERA_FROM_DAY here — never by inserting into a
   live one: an insert shifts every future board under players mid-rotation. */
var ERA_FROM_DAY = 256;
var RUN_KEY = 'ctt.gridlock.dailyRun.v1';

var SEED    = window.ArcadeDailySeed;
var ROT     = window.ArcadeDailyRotation;
var LB      = window.ArcadeLeaderboard;
var ARCHIVE = window.ArcadeArchive;
var E       = window.GridlockEngine;
var A       = window.GridlockActions;

var $ = function (id) { return document.getElementById(id); };

/* Street, zone, corridor and proposal names are BAKED FROM OSM — third-party
   data rendered into innerHTML. Escaped at every seam that builds markup. */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

/* ── storage: always guarded, private mode throws ── */
function load(k) { try { return JSON.parse(localStorage.getItem(k)) || null; } catch (_) { return null; } }
function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} }

/* ═══ 1. STATE ════════════════════════════════════════════════════ */
var POOL = null;              /* cities/index.json — the era's city pool     */
var CITIES = {};              /* loaded city JSON by id (incl. '_tutorial')  */
var mode = 'daily';
var city = null;              /* the dealt city (frozen data + proposals)    */
var plan = [];                /* THE PLAN IS THE STATE.                      */
var solved = null;            /* GridlockEngine.solve(city, plan)            */
var submitted = false, recapMode = false, tutorialMode = false;
var selected = null;          /* { kind:'link'|'node'|'proposal', id }       */
var hintedLink = null;
var pane = 'site';            /* which drawer pane is showing                */
var tutStep = 0;

var map = null, budgetCon = null, delayCon = null;
var hint = null, resume = null, restart = null;
var lbUi = null, winboard = null, sheet = null, tutorial = null, modes = null;

/* ═══ 2. MONEY, THE PLAN, THE SOLVE ═══════════════════════════════ */
function money(d) { return '$' + (Number(d) / 1e6).toFixed(1) + 'M'; }
function hintsSpent() { return hint ? hint.spent() : 0; }
/* The Consultant's fee comes out of the SAME purse as the roads — that is the
   whole of its price, and the reason the ranked value has no hint term. */
function spent() { return A.totalCost(city, plan) + hintsSpent() * A.consultantFee(city); }
function budgetLeft() { return city.meta.budget - spent(); }
function appliedSet() {
  var s = {};
  plan.forEach(function (p) { s[p.action + ':' + p.site] = true; });
  /* map.js asks a Set. Keep the shape it declared. */
  return { has: function (k) { return !!s[k]; } };
}

function recompute() {
  solved = E.solve(city, plan);
  map.setWorld(solved.world);
  paint();
  if (resume && !submitted && !recapMode && !tutorialMode) resume.save();
}

function paint() {
  if (!city || !solved) return;
  budgetCon.set(budgetLeft());
  delayCon.set(solved.pct);
  map.draw({
    arcRatio: solved.arcRatio, selected: selected, applied: appliedSet(),
    sites: city.sites, hinted: hintedLink,
  });
  /* Standard control 3: the board's SUBJECT, no verb, no period. */
  $('playSub').textContent = city.meta.name;
  $('submitBtn').disabled = submitted || recapMode;
}

function setStatus(html) { $('status').innerHTML = html || ''; }

/* Per-LINK congestion, folded from the directed arcs the way map.js colours
   them: a link is as bad as its worse direction. */
function linkRatios() {
  var g = solved.world.graph, out = new Float64Array(solved.world.city.links.length), i;
  for (i = 0; i < g.arcs.length; i++) {
    var L = g.arcs[i].link;
    if (solved.arcRatio[i] > out[L]) out[L] = solved.arcRatio[i];
  }
  return out;
}
/* The opening line is a FACT about today's board, counted from it — never a
   claim about colours the board may not be showing. Charlottetown's baseline
   tops out at 0.95, so "red roads are over capacity" would have been a lie
   about the launch city on its launch day. */
function congestionLine() {
  var r = linkRatios(), bad = 0, busy = 0, i;
  for (i = 0; i < r.length; i++) { if (r[i] > 1) bad++; else if (r[i] >= 0.8) busy++; }
  if (bad) return bad + (bad === 1 ? ' road is' : ' roads are') + ' over capacity, ' + busy + ' more close to it.';
  if (busy) return busy + (busy === 1 ? ' road is' : ' roads are') + ' close to capacity. Nothing is over capacity yet.';
  return 'Nothing is close to capacity. The delay is in the junctions.';
}
function paintNote() {
  /* Practice / Archive ONLY. EMPTY on the plain daily — `:empty` hides it, and
     the word "Daily" (or a date) there is on the never-re-add list. */
  $('puzzleLabel').textContent = ARCHIVE.isArchiving() ? 'Archive'
    : (mode === 'practice' ? 'Practice' : '');
}

/* ═══ 3. EDITING THE PLAN ════════════════════════════════════════ */
function addAction(action, site, step) {
  if (submitted || recapMode) return;
  if (tutorialMode && !tutorialAllows(action, site)) { nudge(); return; }
  var ok = A.eligible(city, plan, action, site);
  if (ok !== true) { setStatus(esc(ok.charAt(0).toUpperCase() + ok.slice(1)) + '.'); return; }
  var item = { action: action, site: site };
  if (step != null) item.step = step;
  var cost = A.costOf(city, item);
  if (cost > budgetLeft()) {
    setStatus('<b>' + esc(A.BY_ID[action].label) + '</b> costs ' + money(cost) +
      ' — you are short by ' + money(cost - budgetLeft()) + '.');
    return;
  }
  var before = solved ? solved.pct : 0;
  plan.push(item);
  recompute();
  var gain = solved.pct - before;
  setStatus('<b>' + esc(A.BY_ID[action].label) + '</b> · ' + esc(siteName(item)) + '. ' +
    (gain >= 0.05 ? 'Delay removed is up ' + gain.toFixed(1) + ' points.'
     : gain <= -0.05 ? 'That made it ' + (-gain).toFixed(1) + ' points worse.'
     : 'The meter did not move.'));
  if (tutorialMode) tutorial.satisfy();
  renderSheet();
}

/* THE PLAN WITHOUT ONE ITEM — a fresh array of fresh items, so a caller that
   is only ASKING (the results card's leave-one-out) cannot renumber the live
   plan under itself.

   Two rules, and they are the reason this is a function rather than two
   copies. Clear land is a PREREQUISITE, not an improvement: dropping it drops
   the widening it paid for, or the plan holds a lane the rules forbid. And the
   two stepped citywide actions are priced BY STEP (fare 2 costs $4M), so what
   is left re-numbers, or a lone fare step keeps the second step's price.

   Remove and the results card MUST agree about what "without this" means.
   They did not: the card's leave-one-out dropped `clear` on its own, which
   `applyPlan` treats as a no-op, so Clear land was reported at +0.0% while its
   lane — unbuyable without it — was credited with the whole pair's gain. */
function planWithout(src, idx) {
  var it = src[idx];
  var out = src.slice(0, idx).concat(src.slice(idx + 1));
  if (it.action === 'clear') {
    out = out.filter(function (p) {
      return !(p.action === 'lane' && p.site === it.site && city.links[it.site].builtUp);
    });
  }
  out = out.map(function (p) { return { action: p.action, site: p.site, step: p.step }; });
  ['frequency', 'fare'].forEach(function (id) {
    var k = 0;
    out.forEach(function (p) { if (p.action === id) p.step = ++k; });
  });
  return out;
}

function removeAction(idx) {
  if (submitted || recapMode) return;
  var it = plan[idx];
  if (!it) return;
  plan = planWithout(plan, idx);
  setStatus('Removed <b>' + esc(A.BY_ID[it.action].label) + '</b>. ' +
    money(A.costOf(city, it)) + ' back in the budget.');
  recompute();
  renderSheet();
}

function siteName(p) {
  if (p.action === 'lane' || p.action === 'clear') return city.links[p.site].name || 'a road';
  if (p.action === 'newroad') return city.proposals[p.site].name;
  if (p.action === 'parkride') return city.zones[p.site].name;
  if (p.action === 'coordinate') {
    var c = city.sites.corridors.filter(function (x) { return x.id === p.site; })[0];
    return c ? c.name : String(p.site);
  }
  if (p.action === 'frequency' || p.action === 'fare') return 'step ' + (p.step || 1);
  var n = city.nodes[p.site];
  return n ? 'junction ' + p.site : 'a junction';
}

/* ═══ 4. THE DRAWER (shared sheet, three panes) ═══════════════════ */
function openSheet(p) { setPane(p); sheet.open(); }
function setPane(p) {
  pane = p;
  Array.prototype.forEach.call(document.querySelectorAll('.gl-tab'), function (b) {
    var on = b.dataset.pane === p;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  renderSheet();
}

function actionRow(item, label, effect) {
  var cost = A.costOf(city, item);
  var ok = A.eligible(city, plan, item.action, item.site);
  var afford = cost <= budgetLeft();
  var dis = ok !== true || !afford || submitted || recapMode;
  return '<button type="button" class="gl-action' + (dis ? ' is-disabled' : '') +
    '" data-action="' + esc(item.action) +
    '" data-site="' + (item.site == null ? '' : esc(item.site)) +
    '" data-step="' + (item.step == null ? '' : item.step) + '"' + (dis ? ' disabled' : '') + '>' +
    '<span class="gl-action__label">' + esc(label) + '</span>' +
    '<span class="gl-action__cost">' + money(cost) + '</span>' +
    '<span class="gl-action__effect">' + esc(effect) + '</span>' +
    (ok !== true ? '<span class="gl-action__why">' + esc(ok) + '</span>'
     : !afford ? '<span class="gl-action__why">Short by ' + money(cost - budgetLeft()) + '</span>' : '') +
    '</button>';
}

function renderSheet() {
  if (!city) return;
  var body = $('sheetBody'), html = '', title = 'Actions';

  /* Once the plan is in, the build panes have nothing to offer. Every row in
     them would render `disabled` and read as a board that has stopped
     responding; say why instead, and leave the plan itself readable. */
  if ((submitted || recapMode) && pane !== 'plan') {
    $('sheetTitle').textContent = pane === 'city' ? 'Citywide' : 'Here';
    body.innerHTML = '<p class="gl-empty">Today\'s plan is submitted. Nothing more can be built.</p>';
    return;
  }

  if (pane === 'site') {
    /* onTap's link bound, restated where the index is actually read: this is the
       one place `selected` is dereferenced, and city.links[id] has to exist
       before the branch below takes a name off it. */
    if (!selected || (selected.kind === 'link' && selected.id >= city.links.length)) {
      title = 'Here';
      html = '<p class="gl-empty">Tap a road or a marked junction on the map.</p>';
    } else if (selected.kind === 'link') {
      var L = city.links[selected.id];
      title = L.name || 'Road';
      if (city.sites.widenable.indexOf(selected.id) >= 0) {
        if (L.builtUp) html += actionRow({ action: 'clear', site: selected.id }, 'Clear land', A.BY_ID.clear.effect);
        html += actionRow({ action: 'lane', site: selected.id }, 'Add a lane', A.BY_ID.lane.effect);
      }
      city.sites.corridors.forEach(function (c) {
        if (c.nodes.indexOf(L.from) < 0 && c.nodes.indexOf(L.to) < 0) return;
        html += actionRow({ action: 'coordinate', site: c.id }, 'Coordinate signals on ' + c.name, A.BY_ID.coordinate.effect);
      });
      if (!html) html = '<p class="gl-empty">Nothing to build on ' + esc(L.name || 'this road') + '.</p>';
    } else if (selected.kind === 'node') {
      title = 'Junction';
      if (city.sites.turnLane.indexOf(selected.id) >= 0) html += actionRow({ action: 'turnlane', site: selected.id }, 'Dedicated turn lane', A.BY_ID.turnlane.effect);
      if (city.sites.roundabout.indexOf(selected.id) >= 0) html += actionRow({ action: 'roundabout', site: selected.id }, 'Roundabout', A.BY_ID.roundabout.effect);
      if (!html) html = '<p class="gl-empty">Nothing to build at this junction.</p>';
    } else if (selected.kind === 'proposal') {
      var P = city.proposals[selected.id];
      title = P.name;
      html += actionRow({ action: 'newroad', site: selected.id }, 'Build it', A.BY_ID.newroad.effect);
    }
  } else if (pane === 'city') {
    title = 'Citywide';
    var fs = plan.filter(function (p) { return p.action === 'frequency'; }).length;
    var fa = plan.filter(function (p) { return p.action === 'fare'; }).length;
    if (fs < 2) html += actionRow({ action: 'frequency', site: null, step: fs + 1 }, 'More buses (' + (fs + 1) + ' of 2)', A.BY_ID.frequency.effect);
    if (fa < 2) html += actionRow({ action: 'fare', site: null, step: fa + 1 }, 'Cheaper fares (' + (fa + 1) + ' of 2)', A.BY_ID.fare.effect);
    city.sites.parkAndRide.forEach(function (z) {
      html += actionRow({ action: 'parkride', site: z }, 'Park-and-ride: ' + city.zones[z].name, A.BY_ID.parkride.effect);
    });
    if (!html) html = '<p class="gl-empty">Every citywide fix is already in the plan.</p>';
  } else {
    title = 'Your plan';
    var empty = !plan.length && !hintsSpent();
    if (empty) html = '<p class="gl-empty">Nothing yet. ' + money(city.meta.budget) + ' to spend.</p>';
    plan.forEach(function (p, i) {
      html += '<div class="gl-action gl-plan">' +
        '<span class="gl-action__label">' + esc(A.BY_ID[p.action].label) + ' · ' + esc(siteName(p)) + '</span>' +
        '<span class="gl-action__cost">' + money(A.costOf(city, p)) + '</span>' +
        (submitted || recapMode ? ''
          : '<button type="button" class="btn secondary gl-remove" data-idx="' + i + '">Remove</button>') +
        '</div>';
    });
    if (hintsSpent()) {
      html += '<div class="gl-action gl-plan"><span class="gl-action__label">Consultant &times; ' + hintsSpent() +
        '</span><span class="gl-action__cost">' + money(hintsSpent() * A.consultantFee(city)) + '</span></div>';
    }
    if (!empty) html += '<p class="gl-empty">' + money(budgetLeft()) + ' left of ' + money(city.meta.budget) + '.</p>';
  }

  $('sheetTitle').textContent = title;
  body.innerHTML = html;
}

/* ═══ 5. SUBMIT, RESULTS, THE RUN LEDGER ═════════════════════════ */
function loadRun() {
  var r = load(RUN_KEY);
  if (!r || r.date !== SEED.dailyDateKey()) return { date: SEED.dailyDateKey(), result: null };
  return r;
}
function todayResult() { return loadRun().result; }
/* ✓ on the archive calendar. Today answers from the run store; a past day
   answers from leaderboard history, which is the only record that survives
   the date rollover. Archive replays never write either, so a replayed day
   can never earn a ✓ it did not earn live. */
function isDayDone(dateKey) {
  if (dateKey === SEED.dailyDateKey()) {
    var r = load(RUN_KEY);
    if (r && r.date === dateKey && r.result) return true;
  }
  var want = String(dateKey);
  return LB.loadHistory(GAME).some(function (e) { return e && String(e.date) === want; });
}

function submit() {
  if (!solved || submitted || recapMode) return;
  if (tutorialMode) {
    if (!tutorialAllows('submit')) { nudge(); return; }
    /* The tutorial's last step IS the submit. Satisfying it ends the level,
       which hands the player straight to today's real city — a results card
       for a four-road toy town would be noise, not a finish. */
    tutorial.satisfy();
    return;
  }
  submitted = true;
  var pct = Math.round(solved.pct * 10) / 10;
  var value = E.rankedValue(pct);
  var archiving = ARCHIVE.isArchiving();
  var isDaily = mode === 'daily' && !archiving;
  var eligible = false;

  if (isDaily) {
    /* LOCKED daily: the first counted run of the day is the one that stands. */
    var run = loadRun();
    if (!run.result) {
      run.result = { pct: pct, hints: hintsSpent(), plan: plan.slice(), city: city.meta.id };
      save(RUN_KEY, run);
      eligible = true;
      /* NO `hints` KEY. The metric has no hint term to describe — see the
         header. An entry that carried one would make the shared score column
         compose a "+Nh" mark that misdescribes the number beside it.

         `oncePerLane` upserts on (date, lane) instead of appending. The run
         ledger above already guards the second write, but it is a localStorage
         write in a try/catch — a quota failure or a private-mode throw would
         leave `run.result` unset and let a second submit append a duplicate
         row, which `historyStats().solves` counts as two solves. Lower `value`
         wins, which is this metric's direction. */
      LB.recordHistory(GAME, {
        date: SEED.dailyDateKey(), difficulty: LANE, epoch: LB_EPOCH,
        value: value, pct: pct, city: city.meta.id,
      }, { oncePerLane: true });
      LB.reportStats(GAME);
    }
  }
  if (resume) resume.finish();
  if (hint) hint.sync();
  paint();
  renderSheet();
  showResults(pct, value, eligible);
}

/* What did the most: each applied action's LEAVE-ONE-OUT contribution to the
   plan as submitted. One extra solve per action (~40ms each), paid once. */
function topThree() {
  var rows = [];
  plan.forEach(function (p, i) {
    /* A clear that bought a widening has no line of its own: whatever it is
       worth is worth exactly what the lane is worth, and two identical rows
       would crowd a real third action off a three-row list. The lane's row
       carries the pair. */
    if (p.action === 'clear' && plan.some(function (q) {
      return q.action === 'lane' && q.site === p.site && city.links[p.site].builtUp;
    })) return;
    rows.push({ p: p, gain: solved.pct - E.solve(city, planWithout(plan, i)).pct });
  });
  rows.sort(function (a, b) { return b.gain - a.gain; });
  return rows.slice(0, 3).map(function (r) {
    return esc(A.BY_ID[r.p.action].label) + ' · ' + esc(siteName(r.p)) +
      ' <small>' + (r.gain >= 0 ? '+' : '') + r.gain.toFixed(1) + '%</small>';
  }).join('<br>');
}

function shareText() {
  var r = recapMode ? todayResult() : null;
  var pct = r ? r.pct : Math.round(solved.pct * 10) / 10;
  return 'Gridlock — ' + SEED.dailyDateKey() + '\n' +
    city.meta.name + ': ' + pct.toFixed(1) + '% of rush-hour delay removed\n' +
    'connectthethoughts.ca/gridlock';
}

function showResults(pct, value, eligible) {
  var archiving = ARCHIVE.isArchiving();
  var dailyComplete = mode === 'daily' && !archiving && !tutorialMode;
  var actions = [];
  if (archiving) {
    actions.push({ kind: 'back', onClick: function () { ARCHIVE.exitArchive(); modes.sync('daily'); mode = 'daily'; dealDaily(); } });
  } else if (mode === 'practice') {
    actions.push({ kind: 'new', label: 'Plan it again', onClick: function () { dealPractice(); } });
  }
  actions.push({ kind: 'share', onClick: function () { window.ArcadeShare.share({ title: 'Gridlock', text: shareText(), button: $('share-btn') }); } });

  window.ArcadeResults.presentResults({
    mount: $('resultsMount'),
    headline: pct >= 30 ? 'Traffic moves.' : pct >= 10 ? 'Better.' : 'Still jammed.',
    /* The ranked number, in the units every other surface shows. NO
       `hintsUsed`: the Consultant is priced in the budget, not the metric. */
    statHtml: pct.toFixed(1) + '% <small>of rush-hour delay removed</small>',
    subHtml: city.meta.name + ' · ' + money(spent()) + ' of ' + money(city.meta.budget) + ' spent',
    detailHtml: plan.length ? '<b>What did the most</b><br>' + topThree()
      : 'You submitted an empty plan. The city is exactly as you found it.',
    streakHtml: (dailyComplete && LB.streakLineHtml) ? LB.streakLineHtml(GAME) : '',
    dailyComplete: dailyComplete,
    gameSlug: GAME,
    archive: archiving,
    actions: actions,
  });

  var mount = $('resultsMount').querySelector('#lb-inline');
  if (mount && winboard && mode === 'daily' && !archiving) {
    winboard.render(mount, {
      lane: LANE, value: value,
      meta: { pct: pct, city: city.meta.id },
      eligible: !!eligible,
    });
  }
  if (dailyComplete && window.ArcadePlacements) {
    /* `diffLabel` is NOT optional: renderPlacements destructures it and reads
       `diffLabel[d]` for every lane, so omitting it throws for any player who
       has a handle — the only players it renders for at all. */
    window.ArcadePlacements.renderPlacements({
      gameSlug: GAME, epoch: LB_EPOCH, lanes: [LANE], diffLabel: { daily: 'Daily' },
      day: SEED.dailyDateKey(), handle: getHandle(),
    });
  }
}

function recapResults() {
  var r = todayResult();
  if (!r) return;
  showResults(r.pct, E.rankedValue(r.pct), false);
}

function getHandle() { return LB.loadSharedHandle ? LB.loadSharedHandle() : null; }

/* ═══ 6. CITY DATA ═══════════════════════════════════════════════ */
function fetchCity(id) {
  if (CITIES[id]) return Promise.resolve(CITIES[id]);
  return Promise.all([
    fetch('cities/' + id + '.json').then(function (r) {
      if (!r.ok) throw new Error('city ' + id + ': ' + r.status);
      return r.json();
    }),
    /* A city with no corridor proposals ships no .proposals.json at all (the
       tutorial town is one). `engine.applyPlan` and `map.js` both READ
       `city.proposals` unconditionally, so the empty array is injected here
       rather than guarded at a dozen call sites. */
    fetch('cities/' + id + '.proposals.json')
      .then(function (r) { return r.ok ? r.json() : []; })
      .catch(function () { return []; }),
  ]).then(function (a) {
    var c = a[0];
    c.proposals = Array.isArray(a[1]) ? a[1] : [];
    CITIES[id] = c;
    return c;
  });
}

function dayNumber() { return SEED.dailyDayNumber(SEED.dailyDateKey()); }
function cityIdForToday() {
  /* EVERY NEW ERA PASSES `guard: floor(poolLen / 2)` (arcade-daily-rotation.js,
     2026-09-17) — the widest seam the repair can always satisfy, so nothing
     returns inside half its pool. At a pool of one it is 0, exactly what the
     pre-rule default computes, so today's deal does not move; it starts
     mattering the day a new era grows the pool. */
  return POOL[ROT.rotationIndex({
    game: GAME, tier: LANE, poolLen: POOL.length,
    day: dayNumber(), fromDay: ERA_FROM_DAY,
    guard: Math.floor(POOL.length / 2),
  })];
}

/* GridlockMap.create binds its pan/pinch/tap listeners to the element it is
   handed, and destroy() only stops the canvas-fit watch — so a second create()
   on the same <canvas> would stack every gesture. A city change therefore gets
   a FRESH canvas node; the listeners die with the one it replaces. */
function rebuildMap(c) {
  if (map) { map.destroy(); map = null; }
  var old = $('map');
  var fresh = old.cloneNode(false);
  old.parentNode.replaceChild(fresh, old);
  map = window.GridlockMap.create(fresh, c);
  map.onTap(onTap);
}

function onTap(x, y) {
  if (!city || !map || !solved) return;
  var hit = map.hitTest(x, y, city.sites);
  /* hitTest walks the WORLD's link list, which a built `newroad` has grown past
     the end of city.links — and the built road's geometry is the proposal's own,
     so it shadows the dashed line the drawer used to answer on. An id the city
     cannot name goes back to the proposal that put it there; the drawer then
     names the road the player built instead of reading city.links out of range. */
  if (hit && hit.kind === 'link' && hit.id >= city.links.length) {
    var wl = solved.world.city.links[hit.id];
    hit = (wl && wl.proposal != null) ? { kind: 'proposal', id: wl.proposal } : null;
  }
  if (tutorialMode && tutStep === 0) {
    if (!hit || hit.kind !== 'link' || hit.id !== TUT_LINK) { nudge(); return; }
    selected = hit; paint(); openSheet('site'); tutorial.satisfy();
    return;
  }
  selected = hit;
  paint();
  if (hit) openSheet('site');
}

/* ═══ 7. DEALING ═════════════════════════════════════════════════ */
function resetRound(c) {
  city = c;
  plan = [];
  submitted = false; recapMode = false;
  selected = null; hintedLink = null;
  if (hint) hint.reset();
  rebuildMap(c);
  solved = E.solve(city, []);
  map.setWorld(solved.world);
  map.fit();
  paintNote();
}

function dealDaily() {
  mode = 'daily'; tutorialMode = false;
  if (modes) modes.sync('daily');
  var id = cityIdForToday();
  return fetchCity(id).then(function (c) {
    resetRound(c);
    var done = !ARCHIVE.isArchiving() && todayResult();
    if (done && done.city === id) {
      /* A finished daily reloads as a read-only RECAP of what was submitted —
         the plan is on the board, the meter reads what it scored, and the
         Consultant tool is the way back to the results card. */
      recapMode = true;
      plan = (done.plan || []).slice();
      if (hint) hint.restore(done.hints || 0, []);
      recompute();
      setStatus('Submitted: <b>' + done.pct.toFixed(1) + '%</b> of the delay removed. ' +
        '<button class="btn secondary" id="gl-recap" type="button">See results</button>');
      var b = $('gl-recap');
      if (b) b.addEventListener('click', recapResults);
      renderSheet();
      return;
    }
    /* deal identity = the city AND its baseline, so a re-bake that moves the
       numbers invalidates a snapshot scored against the old ones. */
    var saved = resume.begin({ lane: LANE, mode: 'daily', deal: id + ':' + city.meta.baselineDelayVehH });
    /* The documented handshake: begin() deals the run, applyState replays the
       snapshot through `restore`, and `restore` repaints. Only a run with
       nothing to restore needs the first paint done here. */
    if (!(saved && saved.state && resume.applyState(saved.state))) { recompute(); renderSheet(); }
    if (!plan.length) setStatus('Rush hour in ' + esc(city.meta.name) + '. ' + congestionLine());
  }).catch(failed);
}

function dealPractice(id) {
  mode = 'practice'; tutorialMode = false;
  if (modes) modes.sync('practice');
  id = id || POOL[Math.floor(Math.random() * POOL.length)];
  return fetchCity(id).then(function (c) {
    resetRound(c);
    resume.begin({ lane: LANE, mode: 'practice', deal: id });
    recompute();
    setStatus('Practice run. Nothing here is scored.');
    renderSheet();
  }).catch(failed);
}

function failed(err) {
  setStatus('<b>The city would not load.</b> Reload to try again.');
  throw err;
}

/* ═══ 8. THE TUTORIAL LEVEL ══════════════════════════════════════
   Tutorial Town is four roads, one of them red, and exactly enough budget for
   the one fix that helps. Forced once on first play (arcade-tutorial.js's
   level seam), skippable, replayable from the help modal. */
var TUT_CITY = '_tutorial';
var TUT_LINK = 0;                 /* Main St — the only over-capacity road */
var TUT_STEPS = [
  { say: 'Tutorial Town at rush hour. Red means over capacity. Tap the red road.',
    wait: 'action', nudge: 'Tap the red road across the top of the map.' },
  { say: 'Now buy it a lane. Watch the delay meter above the map.',
    wait: 'action', nudge: 'Pick Add a lane in the drawer.',
    highlight: function () { return document.querySelector('#sheetBody .gl-action:not(.is-disabled)'); } },
  { say: 'Every fix moves the jam somewhere else. Submit when you are happy with the plan.',
    wait: 'action', nudge: 'Press Submit plan under the map.',
    onEnter: function () { if (sheet) sheet.close(); },
    highlight: '#submitBtn' },
];

/* The level asks for ONE move per step, so everything else is refused SOFTLY
   with the step's own nudge — a silent refusal reads as a broken game. */
function tutorialAllows(action, site) {
  if (tutStep === 0) return false;
  if (tutStep === 1) return action === 'lane' && site === TUT_LINK;
  return action === 'submit' || action === 'lane';
}
function nudge() {
  var n = tutorial && tutorial.nudge();
  if (n) setStatus(esc(n));
}

function tutorialLevel() {
  return {
    /* CALLED SYNCHRONOUSLY by arcade-tutorial.js, which runs step 0 on the
       very next line — so the toy city is prefetched at boot and this only
       reads it back. A promise here would script an empty board. */
    deal: function () {
      tutorialMode = true; mode = 'daily'; tutStep = 0;
      var c = CITIES[TUT_CITY];
      if (!c) return;
      resetRound(c);
      paint();
      setStatus('');
      renderSheet();
    },
    steps: TUT_STEPS.map(function (s, i) {
      return {
        say: s.say, nudge: s.nudge, wait: s.wait, highlight: s.highlight,
        onEnter: function () { tutStep = i; if (s.onEnter) s.onEnter(); },
      };
    }),
    onEnd: function () { tutorialMode = false; tutStep = 0; if (sheet) sheet.close(); },
    onDone: function () {
      if (window.ArcadeResults.dismissResults) window.ArcadeResults.dismissResults();
      dealDaily();
    },
  };
}

/* ═══ 9. THE CONSULTANT (shared hint control) ════════════════════
   One fact: the worst road on the board as it stands, and the cheapest thing
   that helps it. Computed LIVE from the current plan — never replayed from a
   stored solution, which is the one rule no shared layer can check. */
/* Everything the player could still BUY at this link — eligibility and money
   only, no solving. Cheap enough to ask of every link on the board. */
function candidatesFor(linkId) {
  /* `applyPlan` APPENDS a built proposal's links to the solved world, so
     `world.city.links` runs past `city.links` the moment a new road is in the
     plan. Nothing can be built on one — it is already built, and it is in no
     `sites` list — and reading `city.links[linkId]` for one is `undefined`,
     which took the Consultant out with a TypeError inside `suggest()`. */
  if (linkId == null || linkId >= city.links.length) return [];
  var L = city.links[linkId], cands = [], out = [];
  if (city.sites.widenable.indexOf(linkId) >= 0) {
    cands.push(L.builtUp ? [{ action: 'clear', site: linkId }, { action: 'lane', site: linkId }]
                         : [{ action: 'lane', site: linkId }]);
  }
  [L.from, L.to].forEach(function (n) {
    if (city.sites.turnLane.indexOf(n) >= 0) cands.push([{ action: 'turnlane', site: n }]);
    if (city.sites.roundabout.indexOf(n) >= 0) cands.push([{ action: 'roundabout', site: n }]);
  });
  cands.forEach(function (c) {
    /* Only advise what the player could still afford — the fee has already
       come out of the purse by the time the answer renders. */
    var cost = c.reduce(function (s, x) { return s + A.costOf(city, x); }, 0);
    if (cost > budgetLeft() - A.consultantFee(city)) return;
    if (c.some(function (x) { return A.eligible(city, plan, x.action, x.site) !== true; })) return;
    out.push(c);
  });
  return out;
}
/* The cheapest fix at this link, named. One solve per candidate (at most
   three), so this is only ever asked of ONE link per press. */
function bestFixFor(linkId) {
  var best = null;
  candidatesFor(linkId).forEach(function (c) {
    var p = E.solve(city, plan.concat(c)).pct;
    if (!best || p > best.p) best = { p: p, c: c };
  });
  return best ? best.c.map(function (x) { return A.BY_ID[x.action].label; }).join(' + ') : null;
}
/* Links ordered by the vehicle-delay they carry, worst first. The engine's own
   `worstLinkId` is the worst ARC; a two-way street's delay is the sum of both
   directions, which is the thing a planner would actually rank. */
function linksByDelay() {
  var g = solved.world.graph, d = new Float64Array(solved.world.city.links.length), i, idx = [];
  for (i = 0; i < g.arcs.length; i++) {
    d[g.arcs[i].link] += solved.volumes[i] * (solved.times[i] - g.linkT0[i]);
  }
  /* The delay is accumulated over EVERY arc, including a built proposal's, but
     only the base city's links are ranked: a proposal is already built, so
     naming it as "the worst road you can still act on" is a fact with no move
     behind it. */
  for (i = 0; i < city.links.length; i++) idx.push(i);
  idx.sort(function (a, b) { return d[b] - d[a]; });
  return idx;
}

/* ═══ 10. BOOT ═══════════════════════════════════════════════════ */
function boot() {
  var MC = window.ArcadeMetricCounter;
  var T = window.ArcadeTools;

  /* Budget is a SPEND-DOWN, so it is a tally with its own format, not kind
     'budget' — that kind's tri-state calls an untouched budget "at target" in
     green and then says nothing at all as it drains, which describes a count
     rising TOWARD a target (yard-work's gas vs par), not one falling away
     from it. */
  budgetCon = MC.createMetricCounter({
    mount: $('budgetCounter'), kind: 'tally', label: 'Budget left',
    format: function (v) { return money(v); },
    note: function () { return city ? money(spent()) + ' spent' : ''; },
  });
  /* The RANKED metric. The label is spelled out rather than left to the floor's
     declared word because the tool vocabulary here is closed: this string is the
     same noun the results card and the share line use, and naming it once at the
     counter is what keeps those three surfaces reading as one number. */
  delayCon = MC.createMetricCounter({
    mount: $('delayCounter'), kind: 'tally', label: 'Delay removed',
    format: function (v) { return Number(v).toFixed(1) + '%'; },
  });

  resume = window.ArcadeResume.createResume({
    gameSlug: GAME, version: 1,
    /* The charged-fact KEYS ride with the tally. Without them a reload empties
       the paid-for ledger and the next Consultant press charges a second fee
       for a fact the player already owns. */
    snapshot: function () {
      return {
        city: city ? city.meta.id : null, plan: plan.slice(),
        hints: hintsSpent(), keys: hint ? hint.charged() : [], hinted: hintedLink,
      };
    },
    /* ALWAYS ends in a repaint, including on the paths that restore nothing —
       `applyState` is what drives the board after `begin()` (the module's own
       handshake), so a rejected payload must still leave a painted empty plan
       rather than a dealt city with blank counters. */
    restore: function (s) {
      if (s && city && s.city === city.meta.id && Array.isArray(s.plan)) {
        /* Replay the stored plan against THIS build's rules rather than
           trusting the payload: an item an older build allowed must never
           restore into a plan this build would refuse to score. */
        plan = [];
        s.plan.forEach(function (p) {
          if (!p || !A.BY_ID[p.action]) return;
          if (A.eligible(city, plan, p.action, p.site) !== true) return;
          plan.push({ action: p.action, site: p.site, step: p.step });
        });
        ['frequency', 'fare'].forEach(function (id) {
          var k = 0;
          plan.forEach(function (p) { if (p.action === id) p.step = ++k; });
        });
        if (hint) hint.restore(s.hints || 0, Array.isArray(s.keys) ? s.keys : []);
        hintedLink = (typeof s.hinted === 'number' && s.hinted < city.links.length) ? s.hinted : null;
      }
      recompute();
      renderSheet();
    },
    isDone: function () { return !!todayResult(); },
    isActive: function () { return !submitted && !recapMode && !tutorialMode; },
    accept: function (s) { return !!(s && Array.isArray(s.plan)); },
  });

  hint = window.ArcadeHint.createHint({
    mountTool: T.mountTool, createMetricCounter: MC.createMetricCounter,
    /* HELP family → 'trail'. The label is the arcade's one word for this tool;
       what it is CALLED in Gridlock, and what it costs, live in the title. */
    side: 'trail', id: 'hint-btn', label: 'Hint',
    counter: { mount: $('hintCounter'), label: 'Consultant' },
    title: 'The consultant names the worst road and the cheapest fix for it. The fee comes out of your budget.',
    /* The day-lane ledger. Gridlock is a LOCKED daily, so there is no replay
       to launder through — but a reload is one, and this is what makes a fact
       bought before the refresh still bought after it. */
    sticky: { epoch: LB_EPOCH, lane: function () { return LANE; } },
    suggest: function () {
      if (!solved || !city) return null;
      /* The level is teaching one move at a time; the Consultant is not it.
         Refused HERE rather than through `canHint`, because a false `canHint`
         swallows the press with nothing to show — and a control that does
         nothing at all is the stuck state the automate/override rule exists to
         prevent. A null suggestion charges nothing and routes to `onNothing`,
         which says what the step is waiting for. */
      if (tutorialMode) return null;
      if (A.consultantFee(city) > budgetLeft()) return null;
      /* THE FACT HAS TO BE ACTIONABLE. 30 of Charlottetown's 293 links carry
         nothing that can be built on them, and the very worst link is often
         one of those — "the worst jam is here, and there is nothing to do
         about it" is a true sentence the player just paid for and cannot use.
         So the answer is the worst link that still has a move on it; only if
         NO link does at all does it fall back to naming the worst one bare. */
      var order = linksByDelay(), i;
      for (i = 0; i < order.length; i++) {
        if (candidatesFor(order[i]).length) return { link: order[i], fix: bestFixFor(order[i]) };
      }
      return order.length ? { link: order[0], fix: null } : null;
    },
    /* The suggestion is a LOCATOR: "the worst road" names a different road as
       the plan changes. Key on the FACT — which road, under which plan. */
    keyOf: function (s) { return 'worst:' + s.link + ':' + plan.length; },
    onSuggest: function (s, info) {
      hintedLink = s.link;
      selected = { kind: 'link', id: s.link };
      var L = city.links[s.link];
      setStatus('<b>' + esc(L.name || 'This road') + '</b> is the worst jam you can still act on. ' +
        (s.fix ? 'Best buy here: ' + esc(s.fix) + '.' : 'Nothing left here is affordable — look upstream.') +
        (info && info.repeat ? ' <small>You already paid for this one.</small>'
                             : ' <small>Fee ' + money(A.consultantFee(city)) + '.</small>'));
      recompute();
      /* The fact has a place to land: the drawer opens on the road it named,
         with that road's actions costed. (This is also why arcade-new-card.js
         is NOT vended here — nothing is dealt into a surface the player could
         look away from.) */
      openSheet('site');
    },
    onNothing: function () {
      if (tutorialMode) { nudge(); return; }
      setStatus(city && A.consultantFee(city) > budgetLeft()
        ? 'The consultant costs ' + money(A.consultantFee(city)) + ' and you cannot afford one.'
        : 'Nothing left to point at.');
    },
    canHint: function () { return !!city && !submitted && !recapMode; },
    isFinished: function () { return submitted || recapMode; },
    recap: recapResults,
  });

  restart = window.ArcadeRestart.createRestart({
    resume: resume, toolId: 'restart-btn',
    title: 'Clear the plan — the budget comes back, the consultant\'s fee does not',
    onRestart: function () {
      /* `isActive` gates the take-back OFFER, never the wipe — arcade-restart.js
         calls `onRestart` unconditionally and says so: "a game that must refuse
         the press entirely still early-returns inside its own onRestart".
         Without this, Restart erases a submitted plan out from under its own
         recap, or the scripted board out from under the coach. */
      if (submitted || recapMode || tutorialMode) { if (tutorialMode) nudge(); return; }
      plan = []; hintedLink = null; selected = null;
      if (hint) hint.reset();
      recompute(); renderSheet();
      setStatus('Plan cleared. ' + money(budgetLeft()) + ' to spend.');
    },
    isActive: function () { return !!city && !submitted && !recapMode && !tutorialMode; },
  });

  sheet = window.ArcadeSheets.createSheet({ sheet: $('actionSheet') });

  modes = window.ArcadeMode.createMode({
    container: $('mode-row'), current: mode,
    onDaily: function () {
      /* While a level is running the coach owns the board — refuse the switch
         softly and snap the optimistically-lit pill back. */
      if (tutorialMode) { nudge(); modes.sync('daily'); return; }
      if (ARCHIVE.isArchiving()) ARCHIVE.exitArchive();
      window.ArcadeResults.dismissResults && window.ArcadeResults.dismissResults();
      dealDaily();
    },
    onPractice: function () {
      if (tutorialMode) { nudge(); modes.sync('daily'); return; }
      window.ArcadeResults.dismissResults && window.ArcadeResults.dismissResults();
      dealPractice();
    },
  });

  lbUi = window.ArcadeLeaderboardUI.createLeaderboardModal({
    gameSlug: GAME, epoch: LB_EPOCH,
    /* NO `difficulties`: single-board mode removes the diff-tab row, labels
       the lane 'daily' and shows one row under "You". */
    youLabel: 'Daily',
    getHandle: getHandle,
    baseDateKey: function () { return SEED.dailyDateKey(); },
    /* `value` is the INVERTED rank number (1000 − round(pct·10)) and means
       nothing to a player. Every surface shows the pct: `meta.pct` when the
       row carries one, the decode otherwise. */
    rowMetric: function (r) {
      var m = r.meta || {};
      var v = r.value != null ? r.value : r.score;
      var pct = m.pct != null ? Number(m.pct) : (1000 - Number(v)) / 10;
      return pct.toFixed(1) + '%';
    },
    youMetric: function (best) {
      if (best == null) return '';
      var pct = best.pct != null ? Number(best.pct) : (1000 - Number(best.value)) / 10;
      return pct.toFixed(1) + '%';
    },
    /* LOWER value is better, so the default "smallest wins" comparator is
       already right — stated here only because the metric reads backwards. */
    bestComparator: function (e, cur) {
      return (e.value != null ? e.value : Infinity) < (cur.value != null ? cur.value : Infinity);
    },
    /* Bucketed in RAW-metric space (percent), ASCENDING, so the chart reads
       worst-first — the documented shape for a moreIsBetter metric. */
    youStats: {
      metricLabel: 'Delay removed',
      metric: function (e) {
        return e.pct != null ? Number(e.pct) : (1000 - Number(e.value)) / 10;
      },
      buckets: [
        { label: 'Under 10%', max: 10 },
        { label: '10–20%', max: 20 },
        { label: '20–30%', max: 30 },
        { label: '30–40%', max: 40 },
        { label: '40% or more' },
      ],
    },
  });
  lbUi.wire();

  winboard = window.ArcadeWinBoard.createWinBoard({
    gameSlug: GAME, epoch: LB_EPOCH, lanes: [LANE], lbUi: lbUi,
    isDaily: function () { return mode === 'daily'; },
    isArchiving: function () { return ARCHIVE.isArchiving(); },
    dayKey: function () { return SEED.dailyDateKey(); },
    getHandle: getHandle,
    setHandle: function (h) { LB.saveSharedHandle && LB.saveSharedHandle(h); },
  });

  ARCHIVE.createArchive({
    /* The calendar pins the replay date ITSELF before calling this, so
       dailyDateKey() is already the replayed day here — this only restarts. */
    loadDailyForDate: function () { dealDaily(); },
    isDayDone: isDayDone,
  }).wire('archive-button');

  tutorial = window.ArcadeTutorial.createTutorial({ gameSlug: GAME, level: tutorialLevel() });
  tutorial.wire();

  /* ── the game's own controls ─────────────────────────────────────
     The play head is icon tools only (Restart lead, Hint trail). "Your plan"
     is the door to every move that has no map referent — the citywide fixes,
     and taking an action back — so it is a play ACTION and lives in
     `.play-actions` under the board, beside Submit. */
  $('planBtn').addEventListener('click', function () { openSheet('plan'); });
  $('submitBtn').addEventListener('click', submit);

  $('sheetBody').addEventListener('click', function (e) {
    var rm = e.target.closest('.gl-remove');
    if (rm) { removeAction(+rm.dataset.idx); return; }
    var b = e.target.closest('.gl-action[data-action]');
    if (!b || b.disabled) return;
    var raw = b.dataset.site;
    var site = raw === '' ? null : (raw !== '' && !isNaN(+raw) ? +raw : raw);
    addAction(b.dataset.action, site, b.dataset.step ? +b.dataset.step : undefined);
  });
  Array.prototype.forEach.call(document.querySelectorAll('.gl-tab'), function (b) {
    b.addEventListener('click', function () { setPane(b.dataset.pane); });
  });

  /* `--arcade-chrome-v` is published off `[data-arcade-board]` in the markup,
     so there is nothing to register here. */

  /* THE POOL AND THE TOY CITY, BOTH BEFORE THE FIRST DECISION.
     arcade-tutorial.js calls level.deal() SYNCHRONOUSLY and runs step 0 on the
     next line, so `_tutorial.json` has to be in hand before pendingLevel() is
     even asked. */
  Promise.all([
    fetch('cities/index.json').then(function (r) { return r.json(); }),
    fetchCity(TUT_CITY),
  ]).then(function (a) {
    POOL = a[0];
    if (tutorial.pendingLevel()) tutorial.beginLevel();
    else dealDaily();
  }).catch(failed);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
})();
