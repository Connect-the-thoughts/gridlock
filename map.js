(function (root) {
  'use strict';
  // Token names verified against connectthethoughts/tokens.css: the brief's
  // css('--text')/css('--surface')/css('--muted') calls used names that don't
  // exist there — substituted for the arcade's real --fg/--bg-elev/--fg-muted
  // (tokens.css:34-35, :32). --good/--warn/--bad are real as given.
  function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888'; }
  var W = { motorway: 6, trunk: 5, primary: 4, secondary: 3, tertiary: 2 };

  function create(canvas, city) {
    var ctx = canvas.getContext('2d'), world = null, view = { s: 1, tx: 0, ty: 0 }, dpr = 1, tapCb = null, fit;
    var bbox = bounds(city.nodes);

    function bounds(nodes) { var b = { x0: 1e18, y0: 1e18, x1: -1e18, y1: -1e18 }; nodes.forEach(function (n) { b.x0 = Math.min(b.x0, n.x); b.y0 = Math.min(b.y0, n.y); b.x1 = Math.max(b.x1, n.x); b.y1 = Math.max(b.y1, n.y); }); return b; }
    function resize() { dpr = window.devicePixelRatio || 1; var r = canvas.getBoundingClientRect(); canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr); }
    fit = function () { resize(); var w = canvas.width, h = canvas.height, pad = 24 * dpr;
      var s = Math.min((w - 2 * pad) / (bbox.x1 - bbox.x0), (h - 2 * pad) / (bbox.y1 - bbox.y0));
      view = { s: s, tx: (w - s * (bbox.x0 + bbox.x1)) / 2, ty: (h + s * (bbox.y0 + bbox.y1)) / 2 }; };
    function toPx(x, y) { return [view.tx + view.s * x, view.ty - view.s * y]; }   // y up in metres, down on screen
    function fromPx(px, py) { return [(px - view.tx) / view.s, (view.ty - py) / view.s]; }

    var lastState = null;
    function draw(state) {
      lastState = state; if (!world) return;
      var g = world.graph, links = world.city.links, nodes = world.city.nodes, i;
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height);
      var good = css('--good'), warn = css('--warn'), bad = css('--bad'), ink = css('--fg'), muted = css('--fg-muted');
      // link ratio = worst of its arcs
      var linkRatio = new Float64Array(links.length);
      for (i = 0; i < g.arcs.length; i++) { var L = g.arcs[i].link; if (state.arcRatio[i] > linkRatio[L]) linkRatio[L] = state.arcRatio[i]; }
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      for (i = 0; i < links.length; i++) {
        var Lk = links[i], r = linkRatio[i];
        ctx.strokeStyle = r > 1 ? bad : r > 0.8 ? warn : good;
        ctx.lineWidth = (W[Lk.cls] || 2) * dpr * (Lk.proposal != null ? 1.3 : 1);
        if (Lk.proposal != null) ctx.setLineDash([]);
        path(Lk.xy); ctx.stroke();
      }
      // unbuilt proposals: dashed ghost
      ctx.setLineDash([6 * dpr, 6 * dpr]); ctx.strokeStyle = muted; ctx.lineWidth = 2 * dpr;
      city.proposals.forEach(function (p, pi) { if (state.applied.has('newroad:' + pi)) return; p.links.forEach(function (L) { path(L.xy); ctx.stroke(); }); });
      ctx.setLineDash([]);
      // site markers
      var siteNodes = {}; state.sites.turnLane.concat(state.sites.roundabout).forEach(function (n) { siteNodes[n] = 1; });
      Object.keys(siteNodes).forEach(function (n) { var nd = nodes[+n], p = toPx(nd.x, nd.y), built = state.applied.has('roundabout:' + n) || state.applied.has('turnlane:' + n);
        ctx.beginPath(); ctx.arc(p[0], p[1], 5 * dpr, 0, 6.2832); ctx.fillStyle = built ? ink : css('--bg-elev'); ctx.strokeStyle = ink; ctx.lineWidth = 1.5 * dpr; ctx.fill(); ctx.stroke(); });
      // hinted link: pulsing ring is CSS territory; here a plain outside halo
      if (state.hinted != null) { ctx.strokeStyle = ink; ctx.lineWidth = ((W[links[state.hinted].cls] || 2) + 6) * dpr; ctx.globalAlpha = 0.25; path(links[state.hinted].xy); ctx.stroke(); ctx.globalAlpha = 1; }
      // selection: outside ring, never a size change to the board
      if (state.selected) sel(state.selected, ink);
      // labels for wide links when zoomed in
      if (view.s > 0.08) { ctx.fillStyle = ink; ctx.font = (11 * dpr) + 'px system-ui, sans-serif';
        for (i = 0; i < links.length; i++) if ((W[links[i].cls] || 0) >= 3 && links[i].name) { var m = links[i].xy[Math.floor(links[i].xy.length / 2)], q = toPx(m[0], m[1]); ctx.fillText(links[i].name, q[0] + 4 * dpr, q[1] - 4 * dpr); } }
    }
    function path(xy) { ctx.beginPath(); for (var k = 0; k < xy.length; k++) { var p = toPx(xy[k][0], xy[k][1]); if (k) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); } }
    function sel(s, ink) { ctx.strokeStyle = ink; ctx.lineWidth = 2 * dpr; ctx.setLineDash([4 * dpr, 3 * dpr]);
      if (s.kind === 'link') { ctx.lineWidth = ((W[world.city.links[s.id].cls] || 2) + 8) * dpr; ctx.globalAlpha = 0.5; path(world.city.links[s.id].xy); ctx.stroke(); ctx.globalAlpha = 1; }
      else if (s.kind === 'node') { var nd = world.city.nodes[s.id], p = toPx(nd.x, nd.y); ctx.beginPath(); ctx.arc(p[0], p[1], 11 * dpr, 0, 6.2832); ctx.stroke(); }
      else if (s.kind === 'proposal') { city.proposals[s.id].links.forEach(function (L) { path(L.xy); ctx.stroke(); }); }
      ctx.setLineDash([]); }

    function distToSeg(px, py, a, b) { var dx = b[0] - a[0], dy = b[1] - a[1], t = dx || dy ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / (dx * dx + dy * dy))) : 0; var x = a[0] + t * dx, y = a[1] + t * dy; return Math.hypot(px - x, py - y); }
    function hitTest(clientX, clientY, sites) {
      var r = canvas.getBoundingClientRect(), px = (clientX - r.left) * dpr, py = (clientY - r.top) * dpr, i, k, best = null, bd = 18 * dpr;
      var nodes = world.city.nodes, links = world.city.links;
      // nodes first (markers are small targets)
      var siteNodes = sites.turnLane.concat(sites.roundabout);
      for (i = 0; i < siteNodes.length; i++) { var nd = nodes[siteNodes[i]], p = toPx(nd.x, nd.y), d = Math.hypot(px - p[0], py - p[1]); if (d < bd) { bd = d; best = { kind: 'node', id: siteNodes[i] }; } }
      if (best) return best;
      bd = 14 * dpr;
      for (i = 0; i < links.length; i++) { var xy = links[i].xy; for (k = 1; k < xy.length; k++) { var d2 = distToSeg(px, py, toPx(xy[k - 1][0], xy[k - 1][1]), toPx(xy[k][0], xy[k][1])); if (d2 < bd) { bd = d2; best = { kind: 'link', id: i }; } } }
      for (i = 0; i < city.proposals.length; i++) city.proposals[i].links.forEach(function (L) { for (var k2 = 1; k2 < L.xy.length; k2++) { var d3 = distToSeg(px, py, toPx(L.xy[k2 - 1][0], L.xy[k2 - 1][1]), toPx(L.xy[k2][0], L.xy[k2][1])); if (d3 < bd) { bd = d3; best = { kind: 'proposal', id: i }; } } });
      return best;
    }

    /* Gestures: drag pans, pinch zooms, wheel zooms, a short still tap selects. */
    var ptrs = {}, moved = false, downAt = null, pinch0 = null;
    canvas.addEventListener('pointerdown', function (e) { canvas.setPointerCapture(e.pointerId); ptrs[e.pointerId] = [e.clientX, e.clientY]; moved = false; downAt = [e.clientX, e.clientY]; if (Object.keys(ptrs).length === 2) pinch0 = pinchState(); });
    canvas.addEventListener('pointermove', function (e) { if (!ptrs[e.pointerId]) return; var prev = ptrs[e.pointerId]; ptrs[e.pointerId] = [e.clientX, e.clientY]; var ids = Object.keys(ptrs);
      if (ids.length === 1) { var dx = (e.clientX - prev[0]) * dpr, dy = (e.clientY - prev[1]) * dpr; if (Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 6) moved = true; if (moved) { view.tx += dx; view.ty += dy; canvas.classList.add('is-dragging'); redraw(); } }
      else if (ids.length === 2 && pinch0) { var p = pinchState(); var f = p.d / pinch0.d; zoomAt(p.cx, p.cy, f * pinch0.s / view.s); view.tx += (p.cx - pinch0.cx); view.ty += (p.cy - pinch0.cy); pinch0 = { d: p.d, cx: p.cx, cy: p.cy, s: view.s }; moved = true; redraw(); } });
    function up(e) { var was = !!ptrs[e.pointerId]; delete ptrs[e.pointerId]; canvas.classList.remove('is-dragging'); if (Object.keys(ptrs).length < 2) pinch0 = null;
      if (was && !moved && Object.keys(ptrs).length === 0 && tapCb) tapCb(e.clientX, e.clientY); }
    canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('wheel', function (e) { e.preventDefault(); var r = canvas.getBoundingClientRect(); zoomAt((e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr, Math.exp(-e.deltaY * 0.0015)); redraw(); }, { passive: false });
    function pinchState() { var ids = Object.keys(ptrs), a = ptrs[ids[0]], b = ptrs[ids[1]], r = canvas.getBoundingClientRect(); return { d: Math.hypot(a[0] - b[0], a[1] - b[1]), cx: ((a[0] + b[0]) / 2 - r.left) * dpr, cy: ((a[1] + b[1]) / 2 - r.top) * dpr, s: view.s }; }
    function zoomAt(px, py, f) { var s2 = Math.max(fitScale() * 0.8, Math.min(fitScale() * 12, view.s * f)); f = s2 / view.s; view.tx = px - f * (px - view.tx); view.ty = py - f * (py - view.ty); view.s = s2; }
    var fitS = null; function fitScale() { if (fitS == null) { var w = canvas.width, h = canvas.height, pad = 24 * dpr; fitS = Math.min((w - 2 * pad) / (bbox.x1 - bbox.x0), (h - 2 * pad) / (bbox.y1 - bbox.y0)); } return fitS; }
    function redraw() { if (lastState) draw(lastState); }

    /* Bitmap follows the CSS box via the shared signal; never window 'resize'. */
    var watch = root.ArcadeCanvasFit ? root.ArcadeCanvasFit.watch(canvas, function () { var c = centreWorld(); resize(); fitS = null; recentre(c); redraw(); }) : null;
    function centreWorld() { return fromPx(canvas.width / 2, canvas.height / 2); }
    function recentre(c) { var p = toPx(c[0], c[1]); view.tx += canvas.width / 2 - p[0]; view.ty += canvas.height / 2 - p[1]; }

    return {
      setWorld: function (w) { world = w; }, draw: draw, fit: function () { fit(); fitS = null; redraw(); },
      hitTest: function (x, y, sites) { return world ? hitTest(x, y, sites) : null; },
      onTap: function (cb) { tapCb = cb; },
      destroy: function () { if (watch) watch.stop(); }
    };
  }
  root.GridlockMap = { create: create };
}(window));
