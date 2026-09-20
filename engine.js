/* Gridlock engine — PURE. No DOM, no randomness, no Math.pow.
   UMD: window.GridlockEngine in the browser, module.exports in Node. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GridlockEngine = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var BPR_ALPHA = 0.15, ITERS = 30;

  function bpr(t0, v, cap) {
    var r = cap > 0 ? v / cap : 10;
    var r4 = r * r * r * r;                 // never Math.pow: bit-identical across engines
    return t0 * (1 + BPR_ALPHA * r4);
  }

  /* Directed arcs from the (possibly two-way) link list. arcs[i] = {link, from, to}. */
  function buildGraph(city) {
    var n = city.nodes.length, out = [], arcs = [], i, L;
    for (i = 0; i < n; i++) out.push([]);
    for (i = 0; i < city.links.length; i++) {
      L = city.links[i];
      arcs.push({ link: i, from: L.from, to: L.to });
      if (!L.oneway) arcs.push({ link: i, from: L.to, to: L.from });
    }
    var linkT0 = new Float64Array(arcs.length), linkCap = new Float64Array(arcs.length);
    for (i = 0; i < arcs.length; i++) {
      L = city.links[arcs[i].link];
      linkT0[i] = L.lengthM / (L.kmh / 3.6);  // seconds at free flow
      linkCap[i] = L.capacityVph;
      out[arcs[i].from].push({ arc: i, to: arcs[i].to });
    }
    return { n: n, arcs: arcs, out: out, linkT0: linkT0, linkCap: linkCap };
  }

  /* Binary-heap Dijkstra. Arc cost = arcTime[arc] + nodePenalty[to] (paid on ENTERING to). */
  function shortestPaths(g, arcTime, nodePenalty, src) {
    var n = g.n, dist = new Float64Array(n), prev = new Int32Array(n), i;
    for (i = 0; i < n; i++) { dist[i] = Infinity; prev[i] = -1; }
    var heap = [], hn = 0;
    function push(d, v) { heap[hn] = { d: d, v: v }; var c = hn++; while (c > 0) { var p = (c - 1) >> 1; if (heap[p].d <= heap[c].d) break; var t = heap[p]; heap[p] = heap[c]; heap[c] = t; c = p; } }
    function pop() { var top = heap[0]; hn--; if (hn > 0) { heap[0] = heap[hn]; var c = 0; for (;;) { var l = 2 * c + 1, r = l + 1, m = c; if (l < hn && heap[l].d < heap[m].d) m = l; if (r < hn && heap[r].d < heap[m].d) m = r; if (m === c) break; var t = heap[m]; heap[m] = heap[c]; heap[c] = t; c = m; } } heap.length = hn; return top; }
    dist[src] = 0; push(0, src);
    while (hn > 0) {
      var cur = pop(); if (cur.d > dist[cur.v]) continue;
      var edges = g.out[cur.v];
      for (i = 0; i < edges.length; i++) {
        var e = edges[i], nd = cur.d + arcTime[e.arc] + nodePenalty[e.to];
        if (nd < dist[e.to]) { dist[e.to] = nd; prev[e.to] = e.arc; push(nd, e.to); }
      }
    }
    return { dist: dist, prevLink: prev };
  }

  /* All-or-nothing load of one origin's demand row onto shortest paths. */
  function loadAON(g, arcTime, nodePenalty, city, carOD, z, volumes, nodeVol) {
    var sp = shortestPaths(g, arcTime, nodePenalty, city.zones[z].node), j, k;
    for (j = 0; j < city.zones.length; j++) {
      var d = carOD[z][j]; if (!(d > 0) || j === z) continue;
      var v = city.zones[j].node;
      if (sp.prevLink[v] < 0) continue;                 // unreachable: dropped (checker forbids this)
      k = 0;
      while (v !== city.zones[z].node) {
        if (k++ >= 100000) throw new Error('loadAON: path exceeds 100000 hops (cycle in prevLink?)');
        var a = sp.prevLink[v]; volumes[a] += d; nodeVol[v] += d; v = g.arcs[a].from;
      }
    }
  }

  /* Frank–Wolfe user equilibrium. Direction y = all-or-nothing load on current times; step λ from a
     24-step bisection on the Beckmann objective's derivative Σ (y−v)·t(v+λ(y−v)) (+ node terms).
     Deterministic; reaches a <0.5% route-time gap in ~30 iterations where plain 1/k averaging
     (MSA) needs hundreds. */
  function assign(city, carOD, opts) {
    opts = opts || {};
    var g = opts.graph || buildGraph(city), m = g.arcs.length, n = g.n;
    var penaltyOf = opts.penaltyOf || function () { return 0; };
    var volumes = new Float64Array(m), times = new Float64Array(m), nodeVol = new Float64Array(n);
    var nodePenalty = new Float64Array(n), it, i, z;
    for (i = 0; i < m; i++) times[i] = g.linkT0[i];
    for (i = 0; i < n; i++) nodePenalty[i] = penaltyOf(i, 0);
    for (it = 1; it <= ITERS; it++) {
      var aonV = new Float64Array(m), aonN = new Float64Array(n);
      for (z = 0; z < city.zones.length; z++) loadAON(g, times, nodePenalty, city, carOD, z, aonV, aonN);
      var step;
      if (it === 1) step = 1;
      else {
        var lo = 0, hi = 1, b;
        for (b = 0; b < 24; b++) {
          var mid = (lo + hi) / 2, d = 0, k;
          for (k = 0; k < m; k++) { var dv = aonV[k] - volumes[k]; if (dv !== 0) d += dv * bpr(g.linkT0[k], volumes[k] + mid * dv, g.linkCap[k]); }
          for (k = 0; k < n; k++) { var dn = aonN[k] - nodeVol[k]; if (dn !== 0) d += dn * penaltyOf(k, nodeVol[k] + mid * dn); }
          if (d > 0) hi = mid; else lo = mid;
        }
        step = (lo + hi) / 2;
      }
      for (i = 0; i < m; i++) { volumes[i] += step * (aonV[i] - volumes[i]); times[i] = bpr(g.linkT0[i], volumes[i], g.linkCap[i]); }
      for (i = 0; i < n; i++) { nodeVol[i] += step * (aonN[i] - nodeVol[i]); nodePenalty[i] = penaltyOf(i, nodeVol[i]); }
    }
    return { volumes: volumes, times: times, nodeVol: nodeVol, nodePenalty: nodePenalty, graph: g };
  }

  function delayOf(g, r) {
    var s = 0, i;
    for (i = 0; i < g.arcs.length; i++) s += r.volumes[i] * (r.times[i] - g.linkT0[i]);
    for (i = 0; i < g.n; i++) s += r.nodeVol[i] * r.nodePenalty[i];
    return s / 3600;                                     // vehicle-hours
  }

  /* ── node penalties (seconds, paid on entering the node) ── */
  var PEN = { signal: 8, stop: 4, roundabout: 3, none: 0 };
  var RB_CAP_PER_LEG = 1200;
  function nodePenaltySeconds(control, legs, mult, vol) {
    var base = (PEN[control] || 0) * legs * mult;
    if (control === 'roundabout') {
      var cap = RB_CAP_PER_LEG * Math.max(1, legs - 1), r = vol / cap, r4 = r * r * r * r;
      return base * (1 + BPR_ALPHA * r4);
    }
    return base;
  }

  /* ── mode choice: binary logit per OD pair, once per plan ── */
  var TRANSIT_TIME_FACTOR = 1.6, FARE_MIN_PER_DOLLAR = 4, LOGIT_SCALE = 0.05, PR_SHARE = 0.3;
  function modeSplit(city, world) {
    var g = world.graph, pen = new Float64Array(g.n), Z = city.zones.length, out = [], z, j;
    var sp = [];
    for (z = 0; z < Z; z++) sp.push(shortestPaths(g, g.linkT0, pen, city.zones[z].node));
    for (z = 0; z < Z; z++) {
      out.push(new Array(Z));
      for (j = 0; j < Z; j++) {
        var trips = city.od[z][j] || 0;
        if (j === z || !(trips > 0)) { out[z][j] = 0; continue; }
        var carMin = sp[z].dist[city.zones[j].node] / 60;
        var trMin = TRANSIT_TIME_FACTOR * carMin + world.headwayMin / 2 + world.fare * FARE_MIN_PER_DOLLAR;
        var shareTr = 1 / (1 + Math.exp(-LOGIT_SCALE * (carMin - trMin)));
        // Math.exp is implementation-approximated like Math.pow (not bit-identical across
        // engines); quantizing to 1e-6 makes a last-ulp difference vanish.
        shareTr = Math.round(shareTr * 1e6) / 1e6;
        var prShift = world.prShift[z] || 0;                 // park-and-ride: fixed share moves before the logit
        out[z][j] = trips * (1 - prShift) * (1 - shareTr);
      }
    }
    return out;
  }

  /* ── plan → world ── */
  var MULT_TURNLANE = 0.6, MULT_COORD = 0.8;
  function applyPlan(city, plan) {
    var nodes = city.nodes.slice(), links = city.links.map(function (L) { return Object.assign({}, L); });
    var control = city.nodes.map(function (n) { return n.control; });
    var nodeMult = new Float64Array(city.nodes.length).fill(1);
    var prShift = new Float64Array(city.zones.length);
    var headway = city.transit.baseHeadwayMin, fare = city.transit.baseFare, freqSteps = 0, i, p;
    for (i = 0; i < plan.length; i++) {
      p = plan[i];
      switch (p.action) {
        case 'lane': links[p.site].capacityVph = links[p.site].capacityVph * (links[p.site].lanes + 1) / links[p.site].lanes; links[p.site].lanes += 1; break;
        case 'clear': break;                                   // prerequisite only
        case 'turnlane': nodeMult[p.site] *= MULT_TURNLANE; break;
        case 'roundabout': control[p.site] = 'roundabout'; break;
        case 'coordinate': {
          var corridor = city.sites.corridors.filter(function (c) { return c.id === p.site; })[0];
          if (corridor) corridor.nodes.forEach(function (n) { nodeMult[n] *= MULT_COORD; });
          // else: stale/unknown corridor id (e.g. a resume/challenge payload) — skip, don't throw
          break;
        }
        case 'newroad': {
          var pr = city.proposals[p.site], base = nodes.length, k;
          for (k = 0; k < pr.newNodes.length; k++) nodes.push(Object.assign({}, pr.newNodes[k], { id: base + k, legs: 2, control: 'none' }));
          for (k = 0; k < pr.links.length; k++) {
            var L = pr.links[k];
            links.push({ id: links.length, from: L.from < 0 ? base + (-L.from - 1) : L.from, to: L.to < 0 ? base + (-L.to - 1) : L.to,
              name: pr.name, cls: L.cls, lanes: L.lanes, oneway: !!L.oneway, kmh: L.kmh, lengthM: L.lengthM,
              capacityVph: capacityFor(L.cls, L.lanes), builtUp: false, xy: L.xy, proposal: p.site });
          }
          break;
        }
        case 'frequency': freqSteps++; headway = Math.round(city.transit.baseHeadwayMin / (freqSteps + 1)); break;
        case 'fare': fare = fare === city.transit.baseFare ? fare / 2 : 0; break;
        case 'parkride': prShift[p.site] = PR_SHARE; break;
        default: throw new Error('unknown action ' + p.action);
      }
    }
    /* A roundabout has no signals: nothing to coordinate, no approach to hold a
       turn lane. The multiplier is therefore a property of the FINAL control, not
       of the order the plan was built in — so clear it once every item is applied.
       Done inside the roundabout case instead, a turn lane or a corridor
       coordination listed after the roundabout would still discount a junction
       that no longer has a signal to discount. */
    for (i = 0; i < control.length; i++) if (control[i] === 'roundabout') nodeMult[i] = 1;
    var wcity = Object.assign({}, city, { nodes: nodes, links: links });
    var graph = buildGraph(wcity);
    return { city: wcity, graph: graph, control: control, nodeMult: nodeMult, headwayMin: headway, fare: fare, prShift: prShift };
  }
  var CAP = { motorway: 1900, trunk: 1700, primary: 1500, secondary: 1200, tertiary: 900 };
  function capacityFor(cls, lanes) { return (CAP[cls] || 900) * lanes; }

  function pctOf(delay, baseline) {
    if (!(baseline > 0)) return 0;
    var p = 100 * (1 - delay / baseline);
    return p < 0 ? 0 : p > 100 ? 100 : p;
  }
  function rankedValue(pct) { return 1000 - Math.round(pct * 10); }

  function solveWorld(city, world) {
    var carOD = modeSplit(city, world);
    var r = assign(world.city, carOD, {
      graph: world.graph,
      penaltyOf: function (i, vol) { return nodePenaltySeconds(world.control[i], world.city.nodes[i].legs, world.nodeMult[i], vol); }
    });
    return { result: r, delayVehH: delayOf(world.graph, r) };
  }

  /* THE entry point. Baseline is recomputed (cheap) so pct is self-consistent even if meta drifts;
     the city checker fences meta.baselineDelayVehH against this same number. */
  function solve(city, plan) {
    plan = plan || [];
    var base = solveWorld(city, applyPlan(city, []));
    var world = applyPlan(city, plan), s = solveWorld(city, world), r = s.result, g = world.graph;
    var ratio = new Float64Array(g.arcs.length), worstArc = -1, worstDelay = -1, i;
    for (i = 0; i < g.arcs.length; i++) {
      ratio[i] = g.linkCap[i] > 0 ? r.volumes[i] / g.linkCap[i] : 0;
      var d = r.volumes[i] * (r.times[i] - g.linkT0[i]);
      if (d > worstDelay) { worstDelay = d; worstArc = i; }
    }
    return {
      pct: pctOf(s.delayVehH, base.delayVehH), delayVehH: s.delayVehH, baselineDelayVehH: base.delayVehH,
      volumes: r.volumes, times: r.times, arcRatio: ratio,
      worstArc: worstArc, worstLinkId: worstArc >= 0 ? g.arcs[worstArc].link : -1, world: world
    };
  }

  return { bpr: bpr, buildGraph: buildGraph, shortestPaths: shortestPaths, assign: assign, delayOf: delayOf,
           applyPlan: applyPlan, modeSplit: modeSplit, solve: solve, pctOf: pctOf, rankedValue: rankedValue,
           nodePenaltySeconds: nodePenaltySeconds, capacityFor: capacityFor,
           ITERS: ITERS };
}));
