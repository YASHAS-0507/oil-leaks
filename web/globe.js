/* Ship Tracker: 3D globe with simulated (fictional) ships on real sea lanes.
   The `vessel` table in the database is the source of truth. The simulation reads it,
   moves the ships and writes positions and status changes back with real SQL.
   Ships are real 3D models (tanker, container ship, bulk carrier) that point along their heading. */
(function () {
  'use strict';

  const COLORS = { running: '#3ddc84', stalled: '#f5c542', leaking: '#ff4d4d' };
  const HEX = { running: 0x3ddc84, stalled: 0xf5c542, leaking: 0xff4d4d };
  const STALL_REASONS = ['Port congestion', 'Awaiting orders', 'Heavy traffic', 'Bad weather', 'Canal queue'];
  const LEAK_REASONS = ['Hull crack', 'Cargo valve failure', 'Corroded fuel line'];
  const R_NM = 3440.065;
  const GLOBE_R = 100;
  const P_STALL = 0.003;                      // per ship per simulated hour
  const P_LEAK = { crude_tanker: 0.0012, product_tanker: 0.0012, container_ship: 0.0004, bulk_carrier: 0.0004 };

  let A, T, globe, shipGroup, land = [], pastSpills = [], routes = new Map(), ships = new Map(), trail = [];
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
        s = { id: row.vessel_id, w: {}, trailAcc: 0, rate: 150 + Math.random() * 350, obj: null };
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
        if (s.obj) shipGroup.remove(s.obj);
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

  /* ---------- 3D ship models ---------- */

  const PALETTE = [0xc2573a, 0x3b6ea5, 0xd8a23a, 0x5b8a5b, 0x8a4f9e, 0xcfcfcf];

  function hullGeometry(widthScale, depth) {
    const w = widthScale;
    const sh = new T.Shape();
    sh.moveTo(-0.55 * w, -2.0); sh.lineTo(0.55 * w, -2.0); sh.lineTo(0.62 * w, 0.9);
    sh.quadraticCurveTo(0.4 * w, 1.9, 0, 2.5);
    sh.quadraticCurveTo(-0.4 * w, 1.9, -0.62 * w, 0.9);
    sh.lineTo(-0.55 * w, -2.0);
    const g = new T.ExtrudeGeometry(sh, { depth, bevelEnabled: false });
    g.rotateX(Math.PI / 2);          // shape length -> +Z (bow), extrusion -> downwards
    g.translate(0, depth, 0);
    return g;
  }

  function box(w, h, d, x, y, z, color) {
    const m = new T.Mesh(new T.BoxGeometry(w, h, d), new T.MeshLambertMaterial({ color }));
    m.position.set(x, y, z);
    return m;
  }

  function makeShip(type, id) {
    const outer = new T.Group();
    const inner = new T.Group();
    outer.add(inner);
    outer.userData.shipId = id;

    const hullMat = new T.MeshLambertMaterial({ color: HEX.running });
    inner.add(new T.Mesh(hullGeometry(1, 0.55), hullMat));
    const deck = new T.Mesh(hullGeometry(0.88, 0.05), new T.MeshLambertMaterial({ color: 0x2b2f33 }));
    deck.position.y = 0.55;
    inner.add(deck);

    const deckY = 0.6;
    inner.add(box(0.95, 0.8, 0.7, 0, deckY + 0.4, -1.45, 0xf2f2f2));            // accommodation block
    inner.add(box(0.7, 0.12, 0.5, 0, deckY + 0.86, -1.45, 0x9aa4ad));           // bridge deck
    const funnel = new T.Mesh(new T.CylinderGeometry(0.13, 0.17, 0.4, 10), hullMat);
    funnel.position.set(0, deckY + 1.05, -1.7);
    inner.add(funnel);

    if (type === 'container_ship') {
      for (let i = 0; i < 4; i++) {
        const z = -0.55 + i * 0.68;
        inner.add(box(0.92, 0.5, 0.6, 0, deckY + 0.25, z, PALETTE[(id + i) % PALETTE.length]));
        if ((id + i) % 2 === 0) inner.add(box(0.85, 0.35, 0.55, 0, deckY + 0.67, z, PALETTE[(id + i + 2) % PALETTE.length]));
      }
    } else if (type === 'bulk_carrier') {
      for (let i = 0; i < 4; i++) inner.add(box(0.8, 0.2, 0.5, 0, deckY + 0.1, -0.6 + i * 0.68, 0x8a8f96));
      [-0.1, 0.8].forEach((z) => inner.add(box(0.05, 0.55, 0.05, 0.5, deckY + 0.3, z, 0xd9d9d9)));
    } else { // tankers
      inner.add(box(0.16, 0.09, 3.0, 0, deckY + 0.06, 0.3, 0xb9c0c7));            // pipe run along the deck
      for (let i = 0; i < 6; i++) inner.add(box(0.7, 0.05, 0.05, 0, deckY + 0.06, -0.75 + i * 0.5, 0xb9c0c7));
      for (let i = 0; i < 3; i++) {
        const c = new T.Mesh(new T.CylinderGeometry(0.12, 0.12, 0.22, 8), new T.MeshLambertMaterial({ color: 0xdadfe3 }));
        c.position.set(0, deckY + 0.16, -0.5 + i * 1.0);
        inner.add(c);
      }
    }

    const halo = new T.Mesh(new T.RingGeometry(2.0, 2.7, 40), new T.MeshBasicMaterial({
      color: HEX.running, transparent: true, opacity: 0.55, side: T.DoubleSide, depthWrite: false }));
    halo.rotation.x = -Math.PI / 2;
    halo.position.y = 0.08;
    inner.add(halo);

    const sel = new T.Mesh(new T.RingGeometry(3.1, 3.5, 40), new T.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.9, side: T.DoubleSide, depthWrite: false }));
    sel.rotation.x = -Math.PI / 2;
    sel.position.y = 0.1;
    sel.visible = false;
    inner.add(sel);

    const hit = new T.Mesh(new T.SphereGeometry(3.4, 8, 6), new T.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));
    hit.position.y = 0.8;
    inner.add(hit);

    outer.userData.parts = { inner, hullMat, halo, sel, status: null };
    outer.userData.up = new T.Vector3();
    outer.userData.fwd = new T.Vector3();
    outer.userData.right = new T.Vector3();
    outer.userData.m = new T.Matrix4();
    return outer;
  }

  function updateShips(now) {
    const cam = globe.camera();
    const alt = Math.max(0.05, cam.position.length() / GLOBE_R - 1);
    const zoom = Math.min(1.5, Math.max(0.12, alt / 1.75));
    const pulse = 1 + 0.18 * Math.sin(now / 260);
    ships.forEach((s) => {
      if (!s.obj) { s.obj = makeShip(s.type, s.id); shipGroup.add(s.obj); }
      const o = s.obj, parts = o.userData.parts;
      if (parts.status !== s.status) {
        parts.status = s.status;
        parts.hullMat.color.setHex(HEX[s.status]);
        parts.hullMat.emissive.setHex(HEX[s.status]).multiplyScalar(0.28);
        parts.halo.material.color.setHex(HEX[s.status]);
      }
      const route = routes.get(s.route_id);
      const c = globe.getCoords(s.lat, s.lng, 0.003);
      o.position.set(c.x, c.y, c.z);
      const ahead = posAt(route, s.progress + s.dir * 0.003);
      const c2 = globe.getCoords(ahead[0], ahead[1], 0.003);
      const { up, fwd, right, m } = o.userData;
      up.set(c.x, c.y, c.z).normalize();
      fwd.set(c2.x - c.x, c2.y - c.y, c2.z - c.z);
      fwd.addScaledVector(up, -fwd.dot(up));
      if (fwd.lengthSq() > 1e-9) {
        fwd.normalize();
        right.crossVectors(up, fwd).normalize();
        m.makeBasis(right, up, fwd);
        o.quaternion.setFromRotationMatrix(m);
      }
      const isSel = s.id === selectedId;
      parts.inner.scale.setScalar(1.35 * zoom * (isSel ? 1.3 : 1));
      parts.halo.scale.setScalar(s.status === 'leaking' ? pulse : 1);
      parts.halo.material.opacity = s.status === 'running' ? 0.4 : 0.65;
      parts.sel.visible = isSel;
    });
  }

  /* ---------- picking (click and hover on 3D ships) ---------- */

  function raySphere(o, d, r) {
    const b = o.x * d.x + o.y * d.y + o.z * d.z;
    const c = o.x * o.x + o.y * o.y + o.z * o.z - r * r;
    const disc = b * b - c;
    if (disc < 0) return null;
    const t = -b - Math.sqrt(disc);
    return t > 0 ? t : null;
  }

  function pickShip(ev) {
    const dom = globe.renderer().domElement;
    const rect = dom.getBoundingClientRect();
    pickShip.ndc = pickShip.ndc || new T.Vector2();
    pickShip.ray = pickShip.ray || new T.Raycaster();
    pickShip.ndc.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    pickShip.ray.setFromCamera(pickShip.ndc, globe.camera());
    const hits = pickShip.ray.intersectObjects(shipGroup.children, true);
    const tGlobe = raySphere(pickShip.ray.ray.origin, pickShip.ray.ray.direction, GLOBE_R);
    for (const h of hits) {
      if (tGlobe !== null && h.distance > tGlobe + 1.5) continue; // ship is on the far side of the globe
      let o = h.object;
      while (o && !o.userData.shipId) o = o.parent;
      if (o) return o.userData.shipId;
    }
    return null;
  }

  function bindPicking() {
    const dom = globe.renderer().domElement;
    let down = null, lastMove = 0;
    const tip = $('g-tip');
    dom.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
    dom.addEventListener('pointerup', (e) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      const quick = performance.now() - down.t < 600;
      down = null;
      if (moved < 6 && quick) { const id = pickShip(e); if (id) select(id, true); }
    });
    dom.addEventListener('pointermove', (e) => {
      const now = performance.now();
      if (now - lastMove < 50 || e.buttons) return;
      lastMove = now;
      const id = pickShip(e);
      dom.style.cursor = id ? 'pointer' : 'grab';
      const s = id && ships.get(id);
      if (s) {
        tip.innerHTML = '<b>' + A.esc(s.name) + '</b><br>' + A.esc(A.pretty(s.type)) + '<br><span style="color:' + COLORS[s.status] + '">' + A.esc(s.status) + '</span>' + (s.reason ? ' · ' + A.esc(s.reason) : '');
        const rect = $('globe').getBoundingClientRect();
        tip.style.left = (e.clientX - rect.left + 14) + 'px';
        tip.style.top = (e.clientY - rect.top + 14) + 'px';
        tip.hidden = false;
      } else tip.hidden = true;
    });
    dom.addEventListener('pointerleave', () => { tip.hidden = true; });
  }

  /* ---------- panel rendering ---------- */

  const tipHtml = (html) => '<div class="gtip">' + html + '</div>';

  function pointsData() {
    const pts = [];
    if (showPast) pastSpills.forEach((p) => pts.push({ kind: 'past', lat: p.latitude, lng: p.longitude, data: p }));
    pts.push(...trail);
    return pts;
  }

  function pushGlobe() { globe.pointsData(pointsData()); }

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
    if (s && focus) globe.pointOfView({ lat: s.lat, lng: s.lng, altitude: 0.9 }, 900);
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
    updateShips(now);
    if (now - lastPush > 250) { lastPush = now; pushGlobe(); }
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
    T = window.THREE;
    const el = $('globe');
    const topo = await (await fetch('vendor/countries-50m.json?v=3')).json();
    land = topojson.feature(topo, topo.objects.countries).features;

    globe = Globe()(el)
      .backgroundColor('rgba(0,0,0,0)')
      .showAtmosphere(true).atmosphereColor('#4da3d4').atmosphereAltitude(0.16)
      .polygonsData(land).polygonCapColor(() => '#27352a').polygonSideColor(() => 'rgba(0,0,0,0)')
      .polygonStrokeColor(() => '#4f6350').polygonAltitude(0.004).polygonsTransitionDuration(0)
      .pathPoints('dense').pathPointLat((p) => p[0]).pathPointLng((p) => p[1])
      .pathColor(() => 'rgba(150,200,255,0.3)').pathStroke(0.3).pathDashLength(0.012).pathDashGap(0.01).pathTransitionDuration(0)
      .pointsMerge(false).pointsTransitionDuration(0)
      .pointLat('lat').pointLng('lng')
      .pointAltitude(0.006)
      .pointRadius((p) => (p.kind === 'trail' ? 0.22 : 0.3))
      .pointColor((p) => (p.kind === 'trail' ? 'rgba(255,77,77,0.4)' : 'rgba(207,216,227,0.85)'))
      .pointLabel((p) => {
        if (p.kind === 'past') {
          const d = p.data;
          return tipHtml('<b>' + A.esc(d.name) + '</b><br>' + A.esc(d.incident_date) + '<br>' + (d.volume_barrels != null ? A.fmt(d.volume_barrels) + ' barrels' : 'volume unknown'));
        }
        return '';
      });

    const mat = globe.globeMaterial();
    mat.color.set('#0c2036');
    if (mat.emissive) mat.emissive.set('#06121e');
    if ('shininess' in mat) mat.shininess = 8;
    globe.pointOfView({ lat: 22, lng: 40, altitude: 1.75 });
    globe.controls().autoRotateSpeed = 0.6;
    globe.controls().minDistance = 112;

    shipGroup = new T.Group();
    globe.scene().add(shipGroup);

    if (window.ResizeObserver) new ResizeObserver(resize).observe(el);
    window.addEventListener('resize', resize);
    bindControls();
    bindPicking();
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
      loadRoutes(); loadPast();
      ships.forEach((s) => { if (s.obj) shipGroup.remove(s.obj); });
      ships.clear();
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

  window.OilGlobe = {
    show, hide,
    _debug: () => ({ ships: [...ships.values()].map((s) => ({ id: s.id, status: s.status, lat: s.lat, lng: s.lng, progress: s.progress, hasModel: !!s.obj })), clock }),
    _select: (id) => select(id, true)
  };
})();
