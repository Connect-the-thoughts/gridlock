#!/usr/bin/env node
// Fences every baked city. Exit 1 on the first failure, naming city + rule.
import { createRequire } from 'node:module';
import { loadCity, poolIds } from './lib/load-city.mjs';
const require = createRequire(import.meta.url);
const E = require('../engine.js');

function fail(city, msg) { console.error(`FAIL ${city}: ${msg}`); process.exit(1); }

for (const id of ['_tutorial', ...poolIds()]) {
  const city = loadCity(id);
  const n = city.nodes.length;
  if (id !== '_tutorial' && (city.links.length < 100 || city.links.length > 400)) fail(id, `link count ${city.links.length} outside 100–400`);
  // connectivity (undirected)
  const adj = Array.from({ length: n }, () => []);
  for (const L of city.links) { adj[L.from].push(L.to); adj[L.to].push(L.from); }
  const seen = new Uint8Array(n); const st = [0]; seen[0] = 1;
  while (st.length) { const v = st.pop(); for (const w of adj[v]) if (!seen[w]) { seen[w] = 1; st.push(w); } }
  if (seen.some((s) => !s)) fail(id, 'graph not connected');
  // zone reachability (directed, free-flow)
  const g = E.buildGraph(city); const pen = new Float64Array(n);
  for (const z of city.zones) {
    const sp = E.shortestPaths(g, g.linkT0, pen, z.node);
    for (const w of city.zones) if (w !== z && !isFinite(sp.dist[w.node])) fail(id, `zone ${z.name} cannot reach ${w.name}`);
  }
  // proposals reference real nodes
  city.proposals.forEach((p, i) => {
    for (const L of p.links) for (const end of [L.from, L.to]) {
      if (end >= 0 && end >= n) fail(id, `proposal ${p.id} link references node ${end} ≥ ${n}`);
      if (end < 0 && -end - 1 >= p.newNodes.length) fail(id, `proposal ${p.id} references new node ${end} it does not define`);
    }
    if (!(p.cost >= 5e6 && p.cost <= 120e6)) fail(id, `proposal ${p.id} cost ${p.cost} outside $5M–$120M`);
  });
  // budget bounds
  if (id !== '_tutorial' && !(city.meta.budget >= 12e6 && city.meta.budget <= 60e6)) fail(id, `budget ${city.meta.budget} outside $12M–$60M`);
  // baseline reproduces bit-for-bit
  const s = E.solve(city, []);
  if (s.baselineDelayVehH !== city.meta.baselineDelayVehH) fail(id, `baseline ${s.baselineDelayVehH} ≠ stored ${city.meta.baselineDelayVehH} — re-bake or update meta`);
  // meta.seededFrom records which zone-seeding path the bake took. It is provenance:
  // a city seeded from the building-count fallback has coarser zones than one seeded
  // from landuse polygons, and that is worth seeing without re-reading the bake log.
  console.log(`ok   ${id}: ${city.links.length} links, ${city.zones.length} zones, baseline ${s.baselineDelayVehH.toFixed(2)} veh·h, budget $${(city.meta.budget / 1e6).toFixed(1)}M`
              + (city.meta.seededFrom ? `\n     zones seeded from ${city.meta.seededFrom}` : ''));
}
