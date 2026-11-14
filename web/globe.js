/* Ship Tracker: 3D globe with simulated (fictional) ships on real sea lanes.
   The `vessel` table in the database is the source of truth. The simulation reads it,
   moves the ships and writes positions and status changes back with real SQL. */
(function () {
  'use strict';

  const COLORS = { running: '#3ddc84', stalled: '#f5c542', leaking: '#ff4d4d' };
  const STALL_REASONS = ['Port congestion', 'Awaiting orders', 'Heavy traffic', 'Bad weather', 'Canal queue'];
  const LEAK_REASONS = ['Hull crack', 'Cargo valve failure', 'Corroded fuel line'];
  const R_NM = 3440.065;
  const P_STALL = 0.003;                      // per ship per simulated hour
  const P_LEAK = { crude_tanker: 0.0012, product_tanker: 0.0012, container_ship: 0.0004, bulk_carrier: 0.0004 };

  let A, globe, land = [], pastSpills = [], routes = new Map(), ships = new Map(), trail = [];
  let clock = 0, hoursPerSec = 3, paused = false, auto = true, visible = false, raf = 0;
  let lastFrame = 0, lastPush = 0, lastSync = 0, lastPanel = 0, selectedId = null, initDone = false, initializing = false;
  let showRoutes = true, showPast = true, lastSql = '';
  const $ = (id) => document.getElementById(id);

  /* ---------- geometry ---------- */

  const rad = (d) => d * Math.PI / 180;
  const deg = (r) => r * 180 / Math.PI;

  function hav(a, b) {
    const h = Math.sin(rad(b[0] - a[0]) / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(rad(b[1] - a[1]) / 2) ** 2;
    return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function gc(a, b, t) {
    const d = hav(a, b) / R_NM;
    if (d === 0) return a;
    const A_ = Math.sin((1 - t) * d) / Math.sin(d), B_ = Math.sin(t * d) / Math.sin(d);
    const x = A_ * Math.cos(rad(a[0])) * Math.cos(rad(a[1])) + B_ * Math.cos(rad(b[0])) * Math.cos(rad(b[1]));
    const y = A_ * Math.cos(rad(a[0])) * Math.sin(rad(a[1])) + B_ * Math.cos(rad(b[0])) * Math.sin(rad(b[1]));
    const z = A_ * Math.sin(rad(a[0])) + B_ * Math.sin(rad(b[0]));
    return [deg(Math.atan2(z, Math.hypot(x, y))), deg(Math.atan2(y, x))];
  }

  function posAt(route, p) {
    let d = p * route.total;
    for (let i = 0; i < route.seg.length; i++) {
      if (d <= route.seg[i] || i === route.seg.length - 1) return gc(route.pts[i], route.pts[i + 1], route.seg[i] ? Math.min(1, d / route.seg[i]) : 0);
      d -= route.seg[i];
    }
    return route.pts[0];
  }

  function buildRoute(id, name, pts) {
    const seg = [];
    let total = 0, dense = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const d = hav(pts[i], pts[i + 1]);
      seg.push(d); total += d;
      const n = Math.max(1, Math.ceil(d / 180));
      for (let k = 0; k < n; k++) dense.push(gc(pts[i], pts[i + 1], k / n));
    }
    dense.push(pts[pts.length - 1]);
    return { id, name, pts, seg, total, dense };
  }

  /* ---------- database sync ---------- */

  function loadRoutes() {
    const r = A.query('SELECT route_id, name FROM shipping_route ORDER BY route_id');
    const w = A.query('SELECT route_id, latitude, longitude FROM route_waypoint ORDER BY route_id, seq');
    routes = new Map();
    r.forEach((x) => {
      const pts = w.filter((p) => p.route_id === x.route_id).map((p) => [p.latitude, p.longitude]);
      if (pts.length >= 2) routes.set(x.route_id, buildRoute(x.route_id, x.name, pts));
    });
  }

  function loadPast() {
    try { pastSpills = A.query('SELECT incident_id, name, incident_date, latitude, longitude, volume_barrels FROM incident'); }
    catch (e) { pastSpills = []; }
  }

  // Read the vessel table. Anything that differs from what the simulation last wrote was edited
  // from outside (for example in the SQL Lab) and wins.
  function syncFromDb(first) {
    const rows = A.query('SELECT * FROM vessel');
    const seen = new Set();
    rows.forEach((row) => {
      if (!routes.has(row.route_id)) return;
      seen.add(row.vessel_id);
      let s = ships.get(row.vessel_id);
      if (!s) {
        s = { id: row.vessel_id, w: {}, trailAcc: 0, rate: 150 + Math.random() * 350 };
        ships.set(row.vessel_id, s);
        s.status = row.status; s.reason = row.status_reason;
        s.until = row.status === 'running' ? Infinity : (first ? clock + 24 + Math.random() * 72 : Infinity);
        s.progress = row.progress; s.dir = row.direction; s.leaked = row.leaked_barrels;
        s.w = { status: row.status, progress: row.progress, dir: row.direction, leaked: row.leaked_barrels };
      } else {
        if (row.status !== s.w.status) { s.status = row.status; s.reason = row.status_reason; s.until = Infinity; s.w.status = row.status; }
        if (row.progress !== s.w.progress) { s.progress = row.progress; s.w.progress = row.progress; }
        if (row.direction !== s.w.dir) { s.dir = row.direction; s.w.dir = row.direction; }
        if (row.leaked_barrels !== s.w.leaked) { s.leaked = row.leaked_barrels; s.w.leaked = row.leaked_barrels; }
      }
      Object.assign(s, { name: row.name, type: row.vessel_type, route_id: row.route_id, speed: row.speed_knots });
      const p = posAt(routes.get(s.route_id), s.progress);
      s.lat = p[0]; s.lng = p[1];
    });
    [...ships.keys()].forEach((id) => { if (!seen.has(id)) { ships.delete(id); if (selectedId === id) selectedId = null; } });
  }

  function writeToDb() {
    let began = false;
    try { A.run('BEGIN'); began = true; } catch (e) { /* a transaction is already open in the SQL Lab */ }
    try {
      const st = A.prepare('UPDATE vessel SET progress = ?, direction = ?, latitude = ?, longitude = ?, leaked_barrels = ? WHERE vessel_id = ?');
      ships.forEach((s) => {
        const leaked = Math.round(s.leaked);
        st.run([s.progress, s.dir, s.lat, s.lng, leaked, s.id]);
        s.w.progress = s.progress; s.w.dir = s.dir; s.w.leaked = leaked;
      });
      st.free();
    } catch (e) { /* table dropped or locked: skip this write */ }
    if (began) { try { A.run('COMMIT'); } catch (e) { /* ignore */ } }
  }

  function setStatus(s, status, reason, until, sql) {
    s.status = status; s.reason = reason; s.until = until;
    try {
      A.run('UPDATE vessel SET status = ?, status_reason = ?, latitude = ?, longitude = ? WHERE vessel_id = ?', [status, reason, s.lat, s.lng, s.id]);
      s.w.status = status;
    } catch (e) { /* ignore */ }
    if (sql) lastSql = "UPDATE vessel SET status = '" + status + "' WHERE vessel_id = " + s.id + ';';
    if (s.id === selectedId) renderSelected(true);
  }

  /* ---------- simulation ---------- */

  function step(dt) {
    const simH = dt * hoursPerSec;
    clock += simH;
    ships.forEach((s) => {
      const route = routes.get(s.route_id);
      if (!route) return;
      if (s.status !== 'stalled') {
        s.progress += s.dir * s.speed * (s.status === 'leaking' ? 0.55 : 1) * simH / route.total;
        if (s.progress >= 1) { s.progress = 1; s.dir = -1; } else if (s.progress <= 0) { s.progress = 0; s.dir = 1; }
      }
      const p = posAt(route, s.progress);
      s.lat = p[0]; s.lng = p[1];
      if (s.status === 'leaking') {
        s.leaked += s.rate * simH;
        s.trailAcc += simH;
        if (s.trailAcc >= 1.5) {
          s.trailAcc = 0;
          trail.push({ kind: 'trail', lat: s.lat, lng: s.lng });
          if (trail.length > 260) trail.shift();
        }
      }
      if (!auto) return;
      if (s.status !== 'running') {
        if (s.until <= clock) setStatus(s, 'running', s.status === 'leaking' ? 'Leak contained' : 'Back underway', Infinity);
      } else if (Math.random() < P_LEAK[s.type] * simH) {
        setStatus(s, 'leaking', LEAK_REASONS[Math.floor(Math.random() * LEAK_REASONS.length)], clock + 24 + Math.random() * 72);
      } else if (Math.random() < P_STALL * simH) {
        setStatus(s, 'stalled', STALL_REASONS[Math.floor(Math.random() * STALL_REASONS.length)], clock + 12 + Math.random() * 36);
      }
    });
  }

  /* ---------- rendering ---------- */

  const tip = (html) => '<div class="gtip">' + html + '</div>';

  function pointsData() {
    const pts = [];
    if (showPast) pastSpills.forEach((p) => pts.push({ kind: 'past', lat: p.latitude, lng: p.longitude, data: p }));
    pts.push(...trail);
    ships.forEach((s) => pts.push({ kind: 'ship', lat: s.lat, lng: s.lng, ship: s }));
    return pts;
  }

  function ringsData() {
    const rings = [];
    ships.forEach((s) => {
      if (s.status === 'leaking') rings.push({ lat: s.lat, lng: s.lng, rgb: '255,77,77' });
      if (s.id === selectedId) rings.push({ lat: s.lat, lng: s.lng, rgb: '255,255,255' });
    });
    return rings;
  }

  function pushGlobe() {
    globe.pointsData(pointsData()).ringsData(ringsData());
  }

  function renderCounts() {
    const c = { running: 0, stalled: 0, leaking: 0 };
    let leaked = 0;
    ships.forEach((s) => { c[s.status] = (c[s.status] || 0) + 1; leaked += s.leaked; });
    $('g-counts').innerHTML = ['running', 'stalled', 'leaking'].map((k) => '<div class="gcount ' + k + '"><b>' + c[k] + '</b><span>' + k + '</span></div>').join('');
    $('g-leaked').textContent = 'Oil leaked by the fleet so far: ' + A.fmt(Math.round(leaked)) + ' barrels';
  }

  function renderEvents() {
    let rows = [];
    try {
      rows = A.query('SELECT e.event_id, v.name, e.event_type, e.note FROM vessel_event e JOIN vessel v ON v.vessel_id = e.vessel_id ORDER BY e.event_id DESC LIMIT 8');
    } catch (e) { /* ignore */ }
    $('g-events').innerHTML = rows.length ? rows.map((r) =>
      '<li><span class="dot ' + A.esc(r.event_type) + '"></span><span><b>' + A.esc(r.name) + '</b> ' + A.esc(r.event_type) + (r.note ? '<br><span class="muted">' + A.esc(r.note) + '</span>' : '') + '</span></li>').join('')
      : '<li class="muted">No events yet. They appear here when a ship changes status.</li>';
  }

  function renderSelected(full) {
    const s = ships.get(selectedId), box = $('g-selected');
    if (!s) { box.innerHTML = '<h3>Selected ship</h3><p class="muted small">Click a ship on the globe.</p>'; return; }
    const route = routes.get(s.route_id);
    if (full || !$('gs-pos')) {
      box.className = 'card shipinfo';
      box.innerHTML = '<h3><span class="dot ' + s.status + '"></span> ' + A.esc(s.name) + '</h3><dl>' +
        '<dt>Type</dt><dd>' + A.esc(A.pretty(s.type)) + '</dd>' +
        '<dt>Route</dt><dd>' + A.esc(route ? route.name : '') + '</dd>' +
        '<dt>Speed</dt><dd>' + s.speed + ' knots</dd>' +
        '<dt>Status</dt><dd>' + A.esc(s.status) + (s.reason ? ' (' + A.esc(s.reason) + ')' : '') + '</dd>' +
        '<dt>Position</dt><dd id="gs-pos"></dd><dt>Leaked</dt><dd id="gs-leaked"></dd></dl>' +
        '<div class="shipbtns"><button class="ghost" data-act="stalled">Stall</button><button class="danger" data-act="leaking">Start leak</button><button class="ghost" data-act="running">Resume</button></div>' +
        '<code class="sqlline">' + A.esc(lastSql || 'Use the buttons to run an UPDATE on this ship.') + '</code>';
      box.querySelectorAll('button').forEach((b) => b.onclick = () => {
        const act = b.dataset.act;
        setStatus(s, act, act === 'stalled' ? 'Awaiting orders (manual)' : act === 'leaking' ? 'Hull crack (manual)' : 'Resumed (manual)', Infinity, true);
        pushGlobe(); renderCounts(); renderEvents();
      });
    }
    $('gs-pos').textContent = s.lat.toFixed(2) + ', ' + s.lng.toFixed(2);
    $('gs-leaked').textContent = A.fmt(Math.round(s.leaked)) + ' barrels';
  }

  function select(id, focus) {
    selectedId = id;
    renderSelected(true);
    const s = ships.get(id);
    if (s && focus) globe.pointOfView({ lat: s.lat, lng: s.lng, altitude: 1.6 }, 900);
    pushGlobe();
  }

  /* ---------- main loop ---------- */

  function frame(now) {
    if (!visible) return;
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - lastFrame) / 1000 || 0);
    lastFrame = now;
    if (!paused) {
      step(dt);
      if (now - lastSync > 2000) {
        lastSync = now;
        try { syncFromDb(false); writeToDb(); } catch (e) { noFleet(); return; }
      }
    }
    if (now - lastPush > 90) { lastPush = now; pushGlobe(); }
    if (now - lastPanel > 600) {
      lastPanel = now;
      renderCounts(); renderEvents();
      if (selectedId) renderSelected(false);
    }
  }

  function noFleet() {
    visible = false;
    cancelAnimationFrame(raf);
    $('g-counts').innerHTML = '';
    $('g-leaked').textContent = 'The fleet tables are missing or were changed. Use "Reset database" in the SQL Lab to restore them.';
  }

  function resize() {
    const el = $('globe');
    if (globe && el.clientWidth) globe.width(el.clientWidth).height(el.clientHeight);
  }

  async function init() {
    A = window.OilApp;
    const el = $('globe');
    const topo = await (await fetch('vendor/countries-110m.json')).json();
    land = topojson.feature(topo, topo.objects.countries).features;

    globe = Globe()(el)
      .backgroundColor('rgba(0,0,0,0)')
      .showAtmosphere(true).atmosphereColor('#4da3d4').atmosphereAltitude(0.16)
      .polygonsData(land).polygonCapColor(() => '#27352a').polygonSideColor(() => 'rgba(0,0,0,0)')
      .polygonStrokeColor(() => '#4f6350').polygonAltitude(0.004).polygonsTransitionDuration(0)
      .pathPoints('dense').pathPointLat((p) => p[0]).pathPointLng((p) => p[1])
      .pathColor(() => 'rgba(150,200,255,0.28)').pathStroke(0.35).pathDashLength(0.012).pathDashGap(0.01).pathTransitionDuration(0)
      .pointsMerge(false).pointsTransitionDuration(0)
      .pointLat('lat').pointLng('lng')
      .pointAltitude((p) => (p.kind === 'ship' ? 0.012 : 0.006))
      .pointRadius((p) => (p.kind === 'ship' ? (p.ship.id === selectedId ? 0.9 : 0.5) : p.kind === 'trail' ? 0.22 : 0.3))
      .pointColor((p) => (p.kind === 'ship' ? COLORS[p.ship.status] : p.kind === 'trail' ? 'rgba(255,77,77,0.4)' : 'rgba(207,216,227,0.85)'))
      .pointLabel((p) => {
        if (p.kind === 'ship') {
          const s = p.ship;
          return tip('<b>' + A.esc(s.name) + '</b><br>' + A.esc(A.pretty(s.type)) + '<br><span style="color:' + COLORS[s.status] + '">' + A.esc(s.status) + '</span>' + (s.reason ? ' · ' + A.esc(s.reason) : ''));
        }
        if (p.kind === 'past') {
          const d = p.data;
          return tip('<b>' + A.esc(d.name) + '</b><br>' + A.esc(d.incident_date) + '<br>' + (d.volume_barrels != null ? A.fmt(d.volume_barrels) + ' barrels' : 'volume unknown'));
        }
        return '';
      })
      .onPointClick((p) => { if (p.kind === 'ship') select(p.ship.id, true); })
      .ringLat('lat').ringLng('lng').ringMaxRadius(3.2).ringPropagationSpeed(1.6).ringRepeatPeriod(1400)
      .ringColor((r) => (t) => 'rgba(' + r.rgb + ',' + (1 - t) + ')');

    const mat = globe.globeMaterial();
    mat.color.set('#0c2036');
    if (mat.emissive) mat.emissive.set('#06121e');
    if ('shininess' in mat) mat.shininess = 8;
    globe.pointOfView({ lat: 22, lng: 40, altitude: 1.75 });
    globe.controls().autoRotateSpeed = 0.6;

    if (window.ResizeObserver) new ResizeObserver(resize).observe(el);
    window.addEventListener('resize', resize);
    bindControls();
    initDone = true;
  }

  function applyPaths() {
    globe.pathsData(showRoutes ? [...routes.values()] : []);
  }

  function bindControls() {
    $('g-speed').onchange = (e) => { hoursPerSec = +e.target.value; };
    $('g-pause').onclick = (e) => { paused = !paused; e.target.textContent = paused ? 'Resume' : 'Pause'; };
    $('g-auto').onchange = (e) => { auto = e.target.checked; };
    $('g-routes').onchange = (e) => { showRoutes = e.target.checked; applyPaths(); };
    $('g-past').onchange = (e) => { showPast = e.target.checked; pushGlobe(); };
    $('g-rotate').onchange = (e) => { globe.controls().autoRotate = e.target.checked; };
  }

  async function show() {
    if (initializing) return;
    visible = true;
    if (!initDone) {
      initializing = true;
      try { await init(); } catch (e) { $('g-leaked').textContent = 'Could not start the globe: ' + e.message; initializing = false; visible = false; return; }
      initializing = false;
    }
    if (!visible) return; // user switched tab while loading
    try {
      loadRoutes(); loadPast(); ships.clear();
      syncFromDb(true);
    } catch (e) { noFleet(); return; }
    applyPaths();
    if (globe.resumeAnimation) globe.resumeAnimation();
    resize();
    renderCounts(); renderEvents(); renderSelected(true); pushGlobe();
    lastFrame = performance.now();
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(frame);
  }

  function hide() {
    visible = false;
    cancelAnimationFrame(raf);
    if (globe && globe.pauseAnimation) globe.pauseAnimation();
  }

  window.OilGlobe = { show, hide, _debug: () => ({ ships: [...ships.values()].map((s) => ({ id: s.id, status: s.status, lat: s.lat, lng: s.lng, progress: s.progress })), clock }) };
})();
