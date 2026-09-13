#!/usr/bin/env python3
"""Bake one city from OpenStreetMap into cities/<id>.json.

Offline tool; never runs in the browser. Deterministic: every iteration over an
OSM collection is sorted, the k-means seed is fixed, and the only floating-point
number the game depends on (meta.baselineDelayVehH) is computed by the JS engine
itself via scripts/lib/baseline.mjs, never by Python.

Usage:  .venv/bin/python scripts/bake-city.py <cityId>
"""
import json, sys, subprocess, math, re
from collections import defaultdict
from pathlib import Path

import numpy as np
import osmnx as ox
import networkx as nx
from pyproj import Transformer
from shapely.geometry import LineString, Point
from shapely.strtree import STRtree

ROOT = Path(__file__).resolve().parents[1]
CFG = json.loads((ROOT / 'scripts' / 'bake-config.json').read_text())

CAP = {'motorway': 1900, 'trunk': 1700, 'primary': 1500, 'secondary': 1200, 'tertiary': 900}
KMH = {'motorway': 100, 'trunk': 90, 'primary': 60, 'secondary': 50, 'tertiary': 50}
PEAK_FACTOR = 0.11        # AM-peak trips per resident
GRAVITY_BETA = 0.08       # per free-flow minute
GRAVITY_ITERS = 20
N_ZONES = 25
BUILT_UP_M = 15.0         # a building this close to the centreline makes a link builtUp
CONSOLIDATE_M = 25.0
PARK_RIDE_MIN_M = 4000.0
CLASS_ORDER = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary']


# ── small helpers ────────────────────────────────────────────────────────────
def values(v):
    """OSM tags arrive as a scalar, or as a LIST when osmnx merged several ways into
    one edge — and that list's order is not stable between runs. Every read goes
    through here, which de-duplicates and sorts, so the bake is reproducible."""
    if v is None:
        return []
    if isinstance(v, (list, tuple, set)):
        return sorted({x for x in v if x is not None}, key=lambda x: str(x))
    return [v]


def first(v):
    vs = values(v)
    return vs[0] if vs else None


def truthy(x):
    return bool(x) and str(x).strip().lower() not in ('no', 'false', '0')


def flag_any(v):
    return any(truthy(x) for x in values(v))


def flag_all(v):
    vs = values(v)
    return bool(vs) and all(truthy(x) for x in vs)


def parent_class(hw):
    """'motorway_link' → 'motorway'; anything unknown → 'tertiary'. When a merged
    edge carries several classes, the most important one wins."""
    best = None
    for h in values(hw):
        if not isinstance(h, str):
            continue
        h = h.replace('_link', '')
        if h in CAP and (best is None or CLASS_ORDER.index(h) < CLASS_ORDER.index(best)):
            best = h
    return best or 'tertiary'


def parse_int(v):
    """Largest integer appearing anywhere in the tag's values (order-independent)."""
    best = None
    for x in values(v):
        m = re.search(r'\d+', str(x))
        if m:
            n = int(m.group(0))
            best = n if best is None else max(best, n)
    return best


def parse_float(v):
    best = None
    for x in values(v):
        try:
            n = float(x)
        except (TypeError, ValueError):
            continue
        best = n if best is None else max(best, n)
    return best


def name_of(datas):
    """Deterministic name for a merged link: the lexicographically first real name
    across every OSM way in the group, else its ref, else a class label."""
    datas = datas if isinstance(datas, (list, tuple)) else [datas]
    for key in ('name', 'ref'):
        found = sorted({str(x).strip() for d in datas for x in values(d.get(key))
                        if isinstance(x, str) and x.strip()})
        if found:
            return found[0]
    return parent_class([v for d in datas for v in values(d.get('highway'))]).capitalize() + ' road'


PLACEHOLDER_NAMES = {c.capitalize() + ' road' for c in CLASS_ORDER}


def is_placeholder(name):
    """name_of()'s last resort is a class label, not a street. It is not a name a
    player can be shown, and it is not a name two links can be grouped by."""
    return name in PLACEHOLDER_NAMES


def norm_name(s):
    return re.sub(r'[^a-z0-9]+', ' ', (s or '').lower()).strip()


# ── fetch + clean the street graph ───────────────────────────────────────────
def fetch_graph(c):
    b = c['bbox']
    classes = '|'.join(c.get('highwayClasses', CLASS_ORDER))
    filt = f'["highway"~"{classes}"]'
    # osmnx 2.x: bbox is a (left, bottom, right, top) = (west, south, east, north) tuple.
    G = ox.graph_from_bbox(
        (b['west'], b['south'], b['east'], b['north']),
        custom_filter=filt, simplify=True, retain_all=False,
    )
    G = ox.project_graph(G)                                    # local metres (UTM)
    raw = G.copy()                                             # keep pre-consolidation tags
    G = ox.simplification.consolidate_intersections(
        G, tolerance=CONSOLIDATE_M, rebuild_graph=True, dead_ends=False)
    G = ox.truncate.largest_component(G, strongly=False)
    return G, raw


def control_lookup(raw):
    """Per pre-consolidation node: (x, y, control-ish tag). A node is a signal when
    OSM tagged it traffic_signals, a roundabout when an incident way is
    junction=roundabout, a stop when tagged highway=stop."""
    nodes = ox.graph_to_gdfs(raw, nodes=True, edges=False)
    roundabout_nodes = set()
    for u, v, _k, d in raw.edges(keys=True, data=True):
        if any(str(x).lower() == 'roundabout' for x in values(d.get('junction'))):
            roundabout_nodes.add(u)
            roundabout_nodes.add(v)
    pts, tags = [], []
    for osmid, row in sorted(nodes.iterrows(), key=lambda r: r[0]):
        hw = str(first(row.get('highway')) or '').lower()
        if hw == 'traffic_signals':
            t = 'signal'
        elif osmid in roundabout_nodes:
            t = 'roundabout'
        elif hw == 'stop':
            t = 'stop'
        else:
            t = 'none'
        pts.append((float(row.geometry.x), float(row.geometry.y)))
        tags.append(t)
    return np.array(pts, dtype=float) if pts else np.zeros((0, 2)), tags


def control_for(xy, pts, tags, radius=CONSOLIDATE_M):
    """Map a consolidated node position back onto the original tags (≤ radius m).
    Priority: signal > roundabout > stop > none (the spec's order)."""
    if len(pts) == 0:
        return 'none'
    d = np.hypot(pts[:, 0] - xy[0], pts[:, 1] - xy[1])
    near = np.nonzero(d <= radius)[0]
    if near.size == 0:
        return 'none'
    found = {tags[i] for i in near}
    for t in ('signal', 'roundabout', 'stop'):
        if t in found:
            return t
    return 'none'


# ── links: merge reciprocal directed edges into one two-way link ─────────────
def collect_links(G):
    groups = defaultdict(list)
    for u, v, k, d in sorted(G.edges(keys=True, data=True), key=lambda e: (e[0], e[1], e[2])):
        if u == v:
            continue                                            # consolidation self-loop
        groups[(min(u, v), max(u, v))].append((u, v, k, d))
    out = []
    for key in sorted(groups):
        es = groups[key]
        dirs = {(u, v) for u, v, _k, _d in es}
        two_way = len(dirs) > 1 or any(not flag_all(d.get('oneway')) for _u, _v, _k, d in es)
        if two_way:
            out.append((es[0][0], es[0][1], False, es))
        else:
            u, v = next(iter(dirs))
            out.append((u, v, True, es))
    return out


def link_geometry(G, u, v, es):
    for _u, _v, _k, d in es:
        g = d.get('geometry')
        if g is not None and g.length > 0:
            coords = list(g.coords)
            # orient the polyline from u to v
            su = (G.nodes[u]['x'], G.nodes[u]['y'])
            if math.dist(coords[0], su) > math.dist(coords[-1], su):
                coords = coords[::-1]
            return LineString(coords)
    return LineString([(G.nodes[u]['x'], G.nodes[u]['y']), (G.nodes[v]['x'], G.nodes[v]['y'])])


# ── landuse / buildings ──────────────────────────────────────────────────────
def features(c, tags, crs):
    b = c['bbox']
    try:
        gdf = ox.features_from_bbox((b['west'], b['south'], b['east'], b['north']), tags)
    except Exception:
        return None
    if gdf is None or len(gdf) == 0:
        return None
    return gdf.to_crs(crs)


def polygon_weights(gdf, keep=None, column='landuse'):
    """→ (centroids Nx2 in projected metres, areas N). `keep` filters the column."""
    if gdf is None or len(gdf) == 0:
        return np.zeros((0, 2)), np.zeros(0)
    g = gdf
    if keep is not None and column in g.columns:
        g = g[g[column].isin(keep)]
    g = g[g.geometry.geom_type.isin(['Polygon', 'MultiPolygon'])]
    if len(g) == 0:
        return np.zeros((0, 2)), np.zeros(0)
    cent = g.geometry.centroid
    pts = np.column_stack([cent.x.to_numpy(float), cent.y.to_numpy(float)])
    area = g.geometry.area.to_numpy(float)
    order = np.lexsort((pts[:, 1], pts[:, 0]))                  # deterministic order
    return pts[order], area[order]


# ── weighted k-means, fixed seed, deterministic ──────────────────────────────
def kmeans(pts, w, k, seed=0, iters=80):
    rng = np.random.default_rng(seed)
    n = len(pts)
    k = min(k, n)
    # weighted k-means++ seeding
    idx = [int(rng.choice(n, p=w / w.sum()))]
    d2 = ((pts - pts[idx[0]]) ** 2).sum(1)
    while len(idx) < k:
        p = d2 * w
        p = p / p.sum() if p.sum() > 0 else np.full(n, 1.0 / n)
        i = int(rng.choice(n, p=p))
        idx.append(i)
        d2 = np.minimum(d2, ((pts - pts[i]) ** 2).sum(1))
    cent = pts[idx].copy()
    lab = np.zeros(n, dtype=int)
    for _ in range(iters):
        dist = ((pts[:, None, :] - cent[None, :, :]) ** 2).sum(2)
        new = dist.argmin(1)
        if (new == lab).all() and _ > 0:
            break
        lab = new
        for j in range(k):
            m = lab == j
            if m.any():
                cent[j] = (pts[m] * w[m, None]).sum(0) / w[m].sum()
    order = np.lexsort((cent[:, 1], cent[:, 0]))                # stable, geographic
    remap = {int(o): i for i, o in enumerate(order)}
    return cent[order], np.array([remap[int(l)] for l in lab])


def nearest_index(pts, xy):
    return int(np.argmin(np.hypot(pts[:, 0] - xy[0], pts[:, 1] - xy[1])))


# ── gravity model ────────────────────────────────────────────────────────────
def gravity(prod, attr, minutes):
    z = len(prod)
    f = np.exp(-GRAVITY_BETA * minutes)
    np.fill_diagonal(f, 0.0)
    a = np.ones(z)
    b = np.ones(z)
    for _ in range(GRAVITY_ITERS):
        # a_i = 1 / Σ_j b_j A_j f_ij ;  b_j = 1 / Σ_i a_i P_i f_ij
        # (the P_i / A_j themselves ride in the T_ij product below — putting them
        #  in the balancing factor too is the classic doubly-constrained blunder)
        denom = (f * (b * attr)[None, :]).sum(1)
        a = np.divide(1.0, denom, out=np.zeros(z), where=denom > 0)
        denom2 = (f * (a * prod)[:, None]).sum(0)
        b = np.divide(1.0, denom2, out=np.zeros(z), where=denom2 > 0)
    od = (a * prod)[:, None] * f * (b * attr)[None, :]
    np.fill_diagonal(od, 0.0)
    return np.round(od, 1)


# ── proposals: endpoints are PLACES, node ids are derived ────────────────────
def repoint_proposals(cid, nodes, to_xy, cx, cy):
    """Node ids are an artefact of the bake — they renumber whenever the network
    moves. So the proposals are authored against places: `_at` carries the two
    endpoints as [lat, lon] and every bake re-derives the link's `from`/`to` and its
    drawn geometry from those. Nothing in that file is a hand-maintained node id,
    which is what used to go stale silently. `lengthM` stays authored: it is the
    alignment's real length, deliberately longer than the straight chord."""
    path = ROOT / 'cities' / f'{cid}.proposals.json'
    if not path.exists():
        return []
    props = json.loads(path.read_text())
    lines = []
    for pr in props:
        at = pr.get('_at')
        assert at and len(at) == 2, f"proposal {pr['id']}: _at needs two [lat, lon] endpoints"
        assert len(pr['links']) == 1, f"proposal {pr['id']}: re-pointing handles one link per proposal"
        ends = []
        for lat, lon in at:
            X, Y = to_xy.transform(lon, lat)
            X, Y = X - cx, Y - cy
            n = min(nodes, key=lambda n: (math.hypot(n['x'] - X, n['y'] - Y), n['id']))
            off = math.hypot(n['x'] - X, n['y'] - Y)
            assert off <= 300.0, (f"proposal {pr['id']}: endpoint {lat},{lon} is {off:.0f} m from the "
                                  f"nearest baked node — re-check _at against the map")
            ends.append((n, off))
        L = pr['links'][0]
        L['from'], L['to'] = ends[0][0]['id'], ends[1][0]['id']
        L['xy'] = [[ends[0][0]['x'], ends[0][0]['y']], [ends[1][0]['x'], ends[1][0]['y']]]
        chord = math.hypot(L['xy'][1][0] - L['xy'][0][0], L['xy'][1][1] - L['xy'][0][1])
        lines.append(f"   {pr['id']}: nodes {L['from']}↔{L['to']} "
                     f"(snapped {ends[0][1]:.0f} m / {ends[1][1]:.0f} m; "
                     f"chord {chord:.0f} m vs authored {L['lengthM']:.0f} m)")
    path.write_text(json.dumps(props, indent=2, ensure_ascii=False) + '\n')
    return lines


# ── main ─────────────────────────────────────────────────────────────────────
def main(cid):
    c = CFG[cid]
    b = c['bbox']
    ox.settings.use_cache = True
    ox.settings.cache_folder = str(ROOT / 'scripts' / 'cache')

    G, raw = fetch_graph(c)
    crs = G.graph['crs']
    to_ll = Transformer.from_crs(crs, 'EPSG:4326', always_xy=True)
    to_xy = Transformer.from_crs('EPSG:4326', crs, always_xy=True)
    cx, cy = to_xy.transform((b['west'] + b['east']) / 2, (b['south'] + b['north']) / 2)

    pts_raw, tags_raw = control_lookup(raw)
    attractors = sorted(c['attractors'], key=lambda a: (-a['weight'], a['name']))
    att_xy = np.array([to_xy.transform(a['lon'], a['lat']) for a in attractors], dtype=float)
    downtown = att_xy[0]

    # ── links (merged) + trim to the 150–300 band ────────────────────────────
    raw_links = collect_links(G)
    trim_m = float(c.get('trimKm', 6)) * 1000.0
    deg = defaultdict(int)
    for u, v, _ow, _es in raw_links:
        deg[u] += 1
        deg[v] += 1
    keep = []
    dropped = 0
    for u, v, ow, es in raw_links:
        cls = parent_class([x for _u, _v, _k, d in es for x in values(d.get('highway'))])
        if cls == 'tertiary' and deg[u] == 2 and deg[v] == 2:
            mid = ((G.nodes[u]['x'] + G.nodes[v]['x']) / 2, (G.nodes[u]['y'] + G.nodes[v]['y']) / 2)
            if math.dist(mid, downtown) > trim_m:
                dropped += 1
                continue
        keep.append((u, v, ow, es))

    # re-run largest component over what survived the trim, then keep only the
    # largest STRONGLY connected component: the checker demands that every zone
    # can DRIVE to every other, and a one-way ramp stub is weakly connected but
    # a directed dead end.
    H = nx.Graph()
    H.add_nodes_from(n for u, v, _o, _e in keep for n in (u, v))
    H.add_edges_from((u, v) for u, v, _o, _e in keep)
    biggest = max(nx.connected_components(H), key=lambda s: (len(s), -min(s)))
    keep = [t for t in keep if t[0] in biggest and t[1] in biggest]
    D = nx.DiGraph()
    D.add_nodes_from(n for u, v, _o, _e in keep for n in (u, v))
    for u, v, ow, _e in keep:
        D.add_edge(u, v)
        if not ow:
            D.add_edge(v, u)
    scc = max(nx.strongly_connected_components(D), key=lambda s: (len(s), -min(s)))
    keep = [t for t in keep if t[0] in scc and t[1] in scc]

    # ── nodes ────────────────────────────────────────────────────────────────
    used = sorted({n for u, v, _o, _e in keep for n in (u, v)},
                  key=lambda n: (round(G.nodes[n]['x'], 3), round(G.nodes[n]['y'], 3), n))
    nid = {n: i for i, n in enumerate(used)}
    legs = defaultdict(int)
    for u, v, _o, _e in keep:
        legs[u] += 1
        legs[v] += 1
    nodes = []
    for n in used:
        x, y = float(G.nodes[n]['x']), float(G.nodes[n]['y'])
        lon, lat = to_ll.transform(x, y)
        nodes.append({'id': nid[n], 'x': round(x - cx, 1), 'y': round(y - cy, 1),
                      'lat': round(lat, 6), 'lon': round(lon, 6),
                      'legs': legs[n], 'control': control_for((x, y), pts_raw, tags_raw)})

    # ── builtUp: a building footprint within 15 m of the centreline ──────────
    bgdf = features(c, {'building': True}, crs)
    btree = None
    if bgdf is not None and len(bgdf) > 0:
        geoms = [g for g in bgdf.geometry.to_list() if g is not None and not g.is_empty]
        if geoms:
            btree = STRtree(geoms)

    links, is_ramp = [], []
    for u, v, ow, es in keep:
        datas = [d for _u, _v, _k, d in es]
        cls = parent_class([x for d in datas for x in values(d.get('highway'))])
        geom = link_geometry(G, u, v, es)
        length = max([parse_float(d.get('length')) or 0.0 for d in datas] + [geom.length])
        if not (length > 0):
            length = max(1.0, math.dist((G.nodes[u]['x'], G.nodes[u]['y']),
                                        (G.nodes[v]['x'], G.nodes[v]['y'])))
        raw_lanes = max([parse_int(d.get('lanes')) or 0 for d in datas] + [0])
        if raw_lanes > 0:
            lanes = raw_lanes if ow else max(1, raw_lanes // 2)
        else:
            lanes = 2 if cls in ('motorway', 'trunk') else 1
        lanes = max(1, min(4, lanes))
        speed = max([parse_int(d.get('maxspeed')) or 0 for d in datas] + [0])
        kmh = speed if speed >= 20 else KMH[cls]
        built = False
        if btree is not None:
            built = len(btree.query(geom.buffer(BUILT_UP_M), predicate='intersects')) > 0
        poly = geom.simplify(5.0)
        xy = [[round(px - cx, 1), round(py - cy, 1)] for px, py in poly.coords]
        bridge = any(flag_any(d.get('bridge')) for d in datas)
        is_ramp.append(any('_link' in str(h) for d in datas for h in values(d.get('highway'))))
        links.append({'id': len(links), 'from': nid[u], 'to': nid[v], 'name': name_of(datas),
                      'cls': cls, 'lanes': lanes, 'oneway': bool(ow), 'kmh': int(kmh),
                      'lengthM': round(length, 1), 'capacityVph': CAP[cls] * lanes,
                      'builtUp': bool(built), 'xy': xy, 'bridge': bool(bridge)})

    ramp = {i for i, r in enumerate(is_ramp) if r}

    # ── names: a slip road inherits the road it serves ───────────────────────
    # OSM gives ramps neither `name` nor `ref` (checked: all 23 of Charlottetown's
    # placeholder-named links are *_link, and none carries a ref), so name_of()
    # falls through to a class label and the player is offered "Add a lane @ Trunk
    # road". A ramp belongs to the road it leaves, so it takes that road's name.
    # Highest class wins — a motorway_link between Cornwall Road and the TCH is a
    # TCH ramp — and ties break lexicographically, so nothing depends on iteration
    # order.
    by_node = defaultdict(list)
    for L in links:
        by_node[L['from']].append(L)
        by_node[L['to']].append(L)
    renamed = 0
    for L in links:
        if L['id'] not in ramp or not is_placeholder(L['name']):
            continue
        near = sorted({(CLASS_ORDER.index(M['cls']), M['name'])
                       for n in (L['from'], L['to']) for M in by_node[n]
                       if M['id'] not in ramp and not is_placeholder(M['name'])})
        if near:
            L['name'] = near[0][1] + ' ramp'
            renamed += 1
    unnamed = sum(1 for L in links if is_placeholder(L['name']))

    node_xy = np.array([[n['x'], n['y']] for n in nodes], dtype=float)

    # ── zones: weighted k-means over residential landuse ─────────────────────
    lgdf = features(c, {'landuse': ['residential', 'retail', 'commercial', 'industrial']}, crs)
    res_pts, res_area = polygon_weights(lgdf, keep=['residential'])
    seeded_from = 'residential landuse polygons'
    if len(res_pts) < 3 * N_ZONES:
        # Ambiguity resolution (b): PEI's landuse tagging is patchy. Fall back to
        # graph node positions weighted by the building count within 250 m.
        seeded_from = 'graph nodes weighted by nearby building count (landuse too sparse)'
        counts = np.ones(len(nodes))
        if btree is not None:
            for i, n in enumerate(nodes):
                p = Point(n['x'] + cx, n['y'] + cy).buffer(250.0)
                counts[i] = 1.0 + len(btree.query(p, predicate='intersects'))
        res_pts, res_area = node_xy + np.array([cx, cy]), counts
    cent, lab = kmeans(res_pts, res_area, N_ZONES, seed=0)
    cent_local = cent - np.array([cx, cy])
    nz = len(cent)

    # attach each zone to a distinct nearest graph node
    taken = set()
    zone_node = []
    for i in range(nz):
        d = np.hypot(node_xy[:, 0] - cent_local[i, 0], node_xy[:, 1] - cent_local[i, 1])
        for j in np.argsort(d, kind='stable'):
            if int(j) not in taken:
                taken.add(int(j))
                zone_node.append(int(j))
                break

    # productions ∝ residential mass in the zone; attractions ∝ non-residential
    # landuse area near the centre PLUS the config attractors' weights.
    prod = np.zeros(nz)
    for i in range(len(res_pts)):
        prod[lab[i]] += res_area[i]
    job_pts, job_area = polygon_weights(lgdf, keep=['retail', 'commercial', 'industrial'])
    jobs = np.zeros(nz)
    for i in range(len(job_pts)):
        jobs[nearest_index(cent, job_pts[i])] += job_area[i]
    pull = np.zeros(nz)
    for i, a in enumerate(attractors):
        pull[nearest_index(cent_local, att_xy[i] - np.array([cx, cy]))] += float(a['weight'])

    def share(v):
        s = v.sum()
        return (v / s if s > 0 else np.full(nz, 1.0 / nz)) + 1.0 / (4 * nz)

    total = c['population'] * PEAK_FACTOR
    prod_s = share(prod)
    attr_s = share(jobs) + share(pull)
    productions = total * prod_s / prod_s.sum()
    attractions = total * attr_s / attr_s.sum()

    zones = [{'id': i, 'node': zone_node[i], 'name': f'Zone {i + 1}',
              'productions': round(float(productions[i]), 1),
              'attractions': round(float(attractions[i]), 1)} for i in range(nz)]

    # ── zone names: the nearest real street, not "Zone 7" ────────────────────
    # The player meets these in "Park-and-ride @ <zone>", where a number says
    # nothing. Each zone takes the nearest named street (ramps and class labels
    # excluded); a street a nearer zone already took falls through to the next
    # one, so no two zones wear the same label and the numbering never comes back
    # except as a last resort.
    streets = [(LineString(L['xy']), L['name']) for L in links
               if L['id'] not in ramp and not is_placeholder(L['name'])]
    taken_names = set()
    for z in zones:
        pt = Point(float(cent_local[z['id']][0]), float(cent_local[z['id']][1]))
        for _d, nm in sorted((g.distance(pt), nm) for g, nm in streets):
            if nm not in taken_names:
                taken_names.add(nm)
                z['name'] = 'near ' + nm
                break

    # ── od: doubly-constrained gravity over free-flow minutes ────────────────
    T = nx.DiGraph()
    T.add_nodes_from(range(len(nodes)))
    for L in links:
        t = L['lengthM'] / (L['kmh'] / 3.6) / 60.0
        T.add_edge(L['from'], L['to'], weight=t)
        if not L['oneway']:
            T.add_edge(L['to'], L['from'], weight=t)
    minutes = np.zeros((nz, nz))
    for i in range(nz):
        dist = nx.single_source_dijkstra_path_length(T, zone_node[i], weight='weight')
        for j in range(nz):
            minutes[i, j] = dist.get(zone_node[j], 1e6)
    od = gravity(productions, attractions, minutes)

    # ── sites (spec §4.2) ────────────────────────────────────────────────────
    widenable = sorted(L['id'] for L in links
                       if L['lanes'] <= 2 and not L['bridge'] and L['cls'] != 'motorway')
    turn_lane = sorted(n['id'] for n in nodes if n['control'] == 'signal' and 3 <= n['legs'] <= 4)
    heavy = set()
    for L in links:
        if L['cls'] in ('motorway', 'trunk'):
            heavy.add(L['from'])
            heavy.add(L['to'])
    roundabout = sorted(n['id'] for n in nodes
                        if 3 <= n['legs'] <= 4 and n['control'] != 'roundabout' and n['id'] not in heavy)

    # corridors: maximal chains of ≥ 3 consecutive signal nodes along one named road
    by_name = defaultdict(list)
    for L in links:
        # Grouping by a class label would invent one corridor out of every unnamed
        # link in the city at once, so a placeholder name groups with nothing.
        if not is_placeholder(L['name']):
            by_name[L['name']].append(L)
    corridors = []
    for nm in sorted(by_name):
        adj = defaultdict(list)
        for L in by_name[nm]:
            adj[L['from']].append(L['to'])
            adj[L['to']].append(L['from'])
        sig = {n for n in adj if nodes[n]['control'] == 'signal'}
        seen = set()
        for s in sorted(sig):
            if s in seen:
                continue
            comp, stack = [], [s]
            seen.add(s)
            while stack:
                v = stack.pop()
                comp.append(v)
                for w in sorted(adj[v]):
                    if w in sig and w not in seen:
                        seen.add(w)
                        stack.append(w)
            if len(comp) >= 3:
                corridors.append({'id': f'c{len(corridors) + 1}', 'name': nm, 'nodes': sorted(comp)})

    # transit corridor nodes: every node touching a link named in the config list
    wanted = [norm_name(s) for s in c['transitCorridorRoads']]
    corridor_nodes = set()
    for L in links:
        # A bus route does not run up a slip road. This matters now that ramps
        # inherit their road's NAME: the substring match below would otherwise pull
        # every Trans-Canada ramp into the transit corridor.
        if L['id'] in ramp:
            continue
        ln = norm_name(L['name'])
        if any(w and (w == ln or w in ln) for w in wanted):
            corridor_nodes.add(L['from'])
            corridor_nodes.add(L['to'])
    corridor_node_ids = sorted(corridor_nodes)

    # A park-and-ride is a lot you leave the car at on the way IN, so the distance
    # that matters is to the trip's destination — the primary attractor from the
    # config (attractors are sorted by weight, so att_xy[0] is downtown). Measuring
    # from the top attraction ZONE instead put the anchor wherever k-means happened
    # to pile up jobs — West Royalty, 5 km out — and shipped lots 1.6 km from the
    # centre of town.
    downtown_local = downtown - np.array([cx, cy])
    park_ride = sorted(z['id'] for z in zones
                       if z['node'] in corridor_nodes
                       and math.dist(tuple(cent_local[z['id']]), tuple(downtown_local)) > PARK_RIDE_MIN_M)

    # ── meta ─────────────────────────────────────────────────────────────────
    per_cap = float(c.get('budgetPerCapita', 250))
    budget = round(min(max(per_cap * c['population'], 12e6), 60e6) / 5e5) * 5e5
    city = {
        'meta': {'id': cid, 'name': c['name'], 'province': c['province'],
                 'population': c['population'], 'bbox': b,
                 'centre': {'lat': (b['south'] + b['north']) / 2, 'lon': (b['west'] + b['east']) / 2},
                 'crs': str(crs), 'budget': int(budget), 'baselineDelayVehH': 0,
                 'seededFrom': seeded_from,
                 'source': 'Map data © OpenStreetMap contributors, ODbL'},
        'nodes': nodes, 'links': links, 'zones': zones, 'od': od.tolist(),
        'sites': {'widenable': widenable, 'turnLane': turn_lane, 'roundabout': roundabout,
                  'corridors': corridors, 'parkAndRide': park_ride},
        'transit': {'baseHeadwayMin': 30, 'baseFare': 2.5, 'corridorNodeIds': corridor_node_ids},
    }

    # ── sanity assertions ────────────────────────────────────────────────────
    assert 100 <= len(links) <= 400, f'link count {len(links)} outside 100–400 (trimmed {dropped})'
    for L in links:
        assert L['lengthM'] > 0 and L['capacityVph'] > 0, f"link {L['id']} has no length/capacity"
    U = nx.Graph()
    U.add_nodes_from(range(len(nodes)))
    U.add_edges_from((L['from'], L['to']) for L in links)
    assert nx.number_connected_components(U) == 1, 'graph not connected'
    for i in range(nz):
        reach = nx.single_source_shortest_path_length(T, zone_node[i])
        missing = [j for j in range(nz) if zone_node[j] not in reach]
        assert not missing, f'zone {i} cannot reach zones {missing}'

    prop_lines = repoint_proposals(cid, nodes, to_xy, cx, cy)

    out = ROOT / 'cities' / f'{cid}.json'
    out.write_text(json.dumps(city, separators=(',', ':')))
    base = float(subprocess.check_output(
        ['node', str(ROOT / 'scripts' / 'lib' / 'baseline.mjs'), str(out)]).decode().strip())
    city['meta']['baselineDelayVehH'] = base
    out.write_text(json.dumps(city, separators=(',', ':')))

    print(f"{cid}: {len(city['links'])} links ({dropped} tertiary trimmed > {c.get('trimKm', 6)} km out), "
          f"{len(city['nodes'])} nodes, {len(city['zones'])} zones, baseline {base:.2f} veh·h, "
          f"budget ${city['meta']['budget'] / 1e6:.1f}M")
    print(f"   zones seeded from: {seeded_from}")
    print(f"   names: {renamed} ramps took the road they serve; {unnamed} links still unnamed")
    if prop_lines:
        print("   proposals re-pointed from _at:")
        for line in prop_lines:
            print(line)
    print(f"   sites: {len(widenable)} widenable, {len(turn_lane)} turn-lane, {len(roundabout)} roundabout, "
          f"{len(corridors)} corridors, {len(park_ride)} park-and-ride; "
          f"{len(corridor_node_ids)} transit-corridor nodes")


if __name__ == '__main__':
    main(sys.argv[1])
