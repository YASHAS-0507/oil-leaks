/* Ship Tracker: 3D globe with simulated (fictional) ships on real sea lanes.
   The `vessel` table in the database is the source of truth. The simulation reads it,
   moves the ships and writes positions and status changes back with real SQL.
   Rendered with CesiumJS. Ships are 3D glTF models (tanker, container ship, bulk carrier) that point along their heading. */
(function () {
  'use strict';

  const COLORS = { running: '#3ddc84', stalled: '#f5c542', leaking: '#ff4d4d' };
  const HEX = { running: 0x3ddc84, stalled: 0xf5c542, leaking: 0xff4d4d };
  const STALL_REASONS = ['Port congestion', 'Awaiting orders', 'Heavy traffic', 'Bad weather', 'Canal queue'];
  const LEAK_REASONS = ['Hull crack', 'Cargo valve failure', 'Corroded fuel line'];
  const R_NM = 3440.065;
  const P_STALL = 0.003;                      // per ship per simulated hour
  const P_LEAK = { crude_tanker: 0.0012, product_tanker: 0.0012, container_ship: 0.0004, bulk_carrier: 0.0004 };

  let A, C, viewer, satLayer, pastEnts = [], routeEnts = [], pastSpills = [], routes = new Map(), ships = new Map(), trail = [];
  let clock = 0, hoursPerSec = 3, paused = false, auto = true, visible = false, raf = 0;
  let lastFrame = 0, lastSync = 0, lastPanel = 0, selectedId = null, initDone = false, initializing = false;
  let showRoutes = true, showPast = true, rotate = false, lastSql = '';
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
    let d = Math.min(1, Math.max(0, p)) * route.total;
    for (let i = 0; i < route.seg.length; i++) {
      if (d <= route.seg[i] || i === route.seg.length - 1) return gc(route.pts[i], route.pts[i + 1], route.seg[i] ? Math.min(1, d / route.seg[i]) : 0);
      d -= route.seg[i];
    }
    return route.pts[0];
  }

  function buildRoute(id, name, pts) {
    const seg = [];
    let total = 0;
    const dense = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const d = hav(pts[i], pts[i + 1]);
      seg.push(d); total += d;
      const n = Math.max(1, Math.ceil(d / 150));
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
        s = { id: row.vessel_id, w: {}, trailAcc: 0, rate: 150 + Math.random() * 350, ent: null, ring: null, selRing: null };
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
    [...ships.keys()].forEach((id) => {
      if (!seen.has(id)) {
        const s = ships.get(id);
        removeShipEnts(s);
        ships.delete(id);
        if (selectedId === id) selectedId = null;
      }
    });
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
          addTrail(s.lat, s.lng);
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

  /* ---------- CesiumJS rendering ---------- */

  const TYPE_FILE = { crude_tanker: 'tanker', product_tanker: 'tanker', container_ship: 'container', bulk_carrier: 'bulk' };
  const modelUri = (type, status) => 'models/' + (TYPE_FILE[type] || 'tanker') + '_' + status + '.glb';
  const cssColor = (status) => C.Color.fromCssColorString(COLORS[status]);

  function removeShipEnts(s) {
    [s.ent, s.ring, s.selRing].forEach((e) => { if (e) viewer.entities.remove(e); });
    s.ent = s.ring = s.selRing = null;
  }

  function addTrail(lat, lng) {
    const e = viewer.entities.add({ position: C.Cartesian3.fromDegrees(lng, lat), point: { pixelSize: 5, color: C.Color.fromCssColorString('#ff4d4d').withAlpha(0.45), disableDepthTestDistance: 0 } });
    trail.push(e);
    if (trail.length > 260) viewer.entities.remove(trail.shift());
  }

  function bearing(a, b) {
    const f1 = rad(a[0]), f2 = rad(b[0]), dl = rad(b[1] - a[1]);
    return Math.atan2(Math.sin(dl) * Math.cos(f2), Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl));
  }

  function makeShipEnts(s) {
    s.ent = viewer.entities.add({
      position: C.Cartesian3.fromDegrees(s.lng, s.lat, 0),
      model: { uri: modelUri(s.type, s.status), minimumPixelSize: 46, maximumScale: 60000, scale: 1, runAnimations: false,
        shadows: C.ShadowMode.DISABLED, silhouetteColor: cssColor(s.status), silhouetteSize: 2.5 }
    });
    s.ent.shipId = s.id;
    s.modelStatus = s.status;
    const color = new C.CallbackProperty(() => cssColor(s.status).withAlpha(s.status === 'running' ? 0.55 : 0.9), false);
    const size = new C.CallbackProperty(() => 34 + (s.status === 'leaking' ? 6 * Math.sin(performance.now() / 260) : 0), false);
    s.ring = viewer.entities.add({
      position: new C.CallbackProperty(() => s.cart, false),
      point: { pixelSize: size, color: C.Color.TRANSPARENT, outlineColor: color, outlineWidth: 3, disableDepthTestDistance: 0 }
    });
    s.ring.shipId = s.id;
    s.selRing = viewer.entities.add({
      position: new C.CallbackProperty(() => s.cart, false),
      show: false,
      point: { pixelSize: 48, color: C.Color.TRANSPARENT, outlineColor: C.Color.WHITE, outlineWidth: 2, disableDepthTestDistance: 0 }
    });
  }

  function updateShips() {
    ships.forEach((s) => {
      if (!s.ent) makeShipEnts(s);
      if (s.modelStatus !== s.status) { s.ent.model.uri = modelUri(s.type, s.status); s.ent.model.silhouetteColor = cssColor(s.status); s.modelStatus = s.status; }
      const route = routes.get(s.route_id);
      s.cart = C.Cartesian3.fromDegrees(s.lng, s.lat, 0);
      const ahead = posAt(route, Math.min(1, Math.max(0, s.progress + s.dir * 0.004)));
      if (Math.abs(ahead[0] - s.lat) + Math.abs(ahead[1] - s.lng) > 1e-6) s.heading = bearing([s.lat, s.lng], ahead) - Math.PI / 2;
      s.ent.position = s.cart;
      s.ent.orientation = C.Transforms.headingPitchRollQuaternion(s.cart, new C.HeadingPitchRoll(s.heading || 0, 0, 0));
      s.selRing.show = s.id === selectedId;
    });
  }

  /* ---------- picking (click and hover on ships and spills) ---------- */

  function pickEntity(pos) {
    const p = viewer.scene.pick(pos);
    return p && p.id && p.id.id !== undefined ? p.id : null;
  }

  function bindPicking() {
    const tip = $('g-tip');
    const handler = new C.ScreenSpaceEventHandler(viewer.scene.canvas);
    handler.setInputAction((m) => {
      const e = pickEntity(m.position);
      if (e && e.shipId) select(e.shipId, true);
    }, C.ScreenSpaceEventType.LEFT_CLICK);
    let last = 0;
    handler.setInputAction((m) => {
      const now = performance.now();
      if (now - last < 60) return;
      last = now;
      const e = pickEntity(m.endPosition);
      viewer.scene.canvas.style.cursor = e && (e.shipId || e.spill) ? 'pointer' : 'default';
      let html = '';
      if (e && e.shipId && ships.get(e.shipId)) {
        const s = ships.get(e.shipId);
        html = '<b>' + A.esc(s.name) + '</b><br>' + A.esc(A.pretty(s.type)) + '<br><span style="color:' + COLORS[s.status] + '">' + A.esc(s.status) + '</span>' + (s.reason ? ' · ' + A.esc(s.reason) : '');
      } else if (e && e.spill) {
        const d = e.spill;
        html = '<b>' + A.esc(d.name) + '</b><br>' + A.esc(d.incident_date) + '<br>' + (d.volume_barrels != null ? A.fmt(d.volume_barrels) + ' barrels' : 'volume unknown');
      }
      if (html) {
        tip.innerHTML = html;
        const rect = $('globe').getBoundingClientRect();
        tip.style.left = (m.endPosition.x + 14) + 'px';
        tip.style.top = (m.endPosition.y + 14) + 'px';
        tip.hidden = false;
      } else tip.hidden = true;
    }, C.ScreenSpaceEventType.MOUSE_MOVE);
  }

  /* ---------- panel rendering ---------- */

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
    if (!s) { box.className = 'card'; box.innerHTML = '<h3>Selected ship</h3><p class="muted small">Click a ship on the globe.</p>'; return; }
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
        renderCounts(); renderEvents();
      });
    }
    $('gs-pos').textContent = s.lat.toFixed(2) + ', ' + s.lng.toFixed(2);
    $('gs-leaked').textContent = A.fmt(Math.round(s.leaked)) + ' barrels';
  }

  function select(id, focus) {
    selectedId = id;
    renderSelected(true);
    const s = ships.get(id);
    if (s && focus) viewer.camera.flyTo({ destination: C.Cartesian3.fromDegrees(s.lng, s.lat, 400000), orientation: { heading: 0, pitch: -C.Math.PI_OVER_TWO, roll: 0 }, duration: 1.4 });
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
    updateShips();
    if (rotate) viewer.camera.rotate(C.Cartesian3.UNIT_Z, -0.0006);
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

  function resize() { if (viewer) viewer.resize(); }

  async function init() {
    A = window.OilApp;
    C = window.Cesium;
    const el = $('globe');
    const base = C.ImageryLayer.fromProviderAsync(C.TileMapServiceImageryProvider.fromUrl(C.buildModuleUrl('Assets/Textures/NaturalEarthII')));
    viewer = new C.Viewer(el, {
      baseLayer: base, baseLayerPicker: false, geocoder: false, homeButton: false, sceneModePicker: false,
      navigationHelpButton: false, animation: false, timeline: false, fullscreenButton: false,
      infoBox: false, selectionIndicator: false, terrain: undefined, shouldAnimate: true
    });
    const scene = viewer.scene;
    scene.globe.baseColor = C.Color.fromCssColorString('#0b2238');
    scene.globe.showGroundAtmosphere = true;
    scene.globe.enableLighting = false;
    scene.backgroundColor = C.Color.fromCssColorString('#05080d');
    scene.skyAtmosphere.show = true;
    scene.highDynamicRange = false;
    scene.screenSpaceCameraController.minimumZoomDistance = 20000;
    viewer.camera.setView({ destination: C.Cartesian3.fromDegrees(45, 18, 15500000) });
    // light the ships from the camera side so hull colours stay readable
    scene.light = new C.DirectionalLight({ direction: viewer.camera.directionWC.clone(), intensity: 2.2 });
    scene.preRender.addEventListener(() => { scene.light.direction = C.Cartesian3.clone(viewer.camera.directionWC, scene.light.direction); });
    if (window.ResizeObserver) new ResizeObserver(resize).observe(el);
    window.addEventListener('resize', resize);
    bindControls();
    bindPicking();
    setSatellite(true);
    initDone = true;
  }

  function applyPaths() {
    routeEnts.forEach((e) => viewer.entities.remove(e));
    routeEnts = [...routes.values()].map((r) => viewer.entities.add({
      show: showRoutes,
      polyline: { positions: C.Cartesian3.fromDegreesArray(r.dense.flatMap((p) => [p[1], p[0]])), width: 1.6, arcType: C.ArcType.GEODESIC,
        material: new C.PolylineDashMaterialProperty({ color: C.Color.fromCssColorString('#96c8ff').withAlpha(0.55), dashLength: 14 }) }
    }));
  }

  function applyPast() {
    pastEnts.forEach((e) => viewer.entities.remove(e));
    pastEnts = pastSpills.map((p) => {
      const e = viewer.entities.add({ show: showPast, position: C.Cartesian3.fromDegrees(p.longitude, p.latitude),
        point: { pixelSize: 8, color: C.Color.fromCssColorString('#cfd8e3'), outlineColor: C.Color.BLACK.withAlpha(0.6), outlineWidth: 1, disableDepthTestDistance: 0 } });
      e.spill = p;
      return e;
    });
  }

  function bindControls() {
    $('g-speed').onchange = (e) => { hoursPerSec = +e.target.value; };
    $('g-pause').onclick = (e) => { paused = !paused; e.target.textContent = paused ? 'Resume' : 'Pause'; };
    $('g-auto').onchange = (e) => { auto = e.target.checked; };
    $('g-routes').onchange = (e) => { showRoutes = e.target.checked; routeEnts.forEach((r) => { r.show = showRoutes; }); };
    $('g-past').onchange = (e) => { showPast = e.target.checked; pastEnts.forEach((p) => { p.show = showPast; }); };
    $('g-rotate').onchange = (e) => { rotate = e.target.checked; };
    $('g-sat').onchange = (e) => setSatellite(e.target.checked);
  }

  function setSatellite(on) {
    if (on && !satLayer) {
      satLayer = viewer.imageryLayers.addImageryProvider(new C.UrlTemplateImageryProvider({
        url: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        maximumLevel: 18, credit: 'Imagery: Esri, Maxar, Earthstar Geographics, and the GIS User Community' }));
    }
    if (satLayer) satLayer.show = on;
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
      loadRoutes(); loadPast();
      ships.forEach(removeShipEnts);
      ships.clear();
      syncFromDb(true);
    } catch (e) { noFleet(); return; }
    viewer.useDefaultRenderLoop = true;
    applyPaths(); applyPast();
    resize();
    renderCounts(); renderEvents(); renderSelected(true);
    lastFrame = performance.now();
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(frame);
  }

  function hide() {
    visible = false;
    cancelAnimationFrame(raf);
    if (viewer) viewer.useDefaultRenderLoop = false;
  }

  window.OilGlobe = {
    show, hide,
    _debug: () => ({ ships: [...ships.values()].map((s) => ({ id: s.id, status: s.status, lat: s.lat, lng: s.lng, progress: s.progress, hasModel: !!s.ent })), clock }),
    _select: (id) => select(id, true),
    _viewer: () => viewer
  };
})();
