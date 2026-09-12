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
      while (v !== city.zones[z].node && k++ < 100000) {
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

  return { bpr: bpr, buildGraph: buildGraph, shortestPaths: shortestPaths, assign: assign, delayOf: delayOf,
           ITERS: ITERS };
}));
