/* Oil Leaks Database: live site. Runs a real SQLite engine (sql.js) in the browser. */
(function () {
  'use strict';

  const STORE_KEY = 'oil_leaks_db_v1';
  const ENV_COLORS = { land: '#d1ab5f', freshwater: '#62bf8f', marine: '#4da3d4', mixed: '#b78fdb' };

  let SQL, db, all = [], map, layer, dirty = true, sampleQueries = [];
  const state = { q: '', env: '', src: '', cause: '', from: '', to: '', known: false, sort: 'incident_date', dir: 'desc' };

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => (n == null ? null : Number(n).toLocaleString('en-US'));
  const pretty = (s) => String(s).replace(/_/g, ' ');

  /* ---------- database helpers ---------- */

  function query(sql, params) {
    const res = db.exec(sql, params);
    if (!res.length) return [];
    const { columns, values } = res[0];
    return values.map((row) => Object.fromEntries(row.map((v, i) => [columns[i], v])));
  }

  function bytesToBase64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  function base64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function persist() {
    try { localStorage.setItem(STORE_KEY, bytesToBase64(db.export())); showBanner(true); }
    catch (e) { /* storage full or unavailable: edits still work for this session */ }
    // db.export() closes pragma state, so restore it
    db.run('PRAGMA foreign_keys = ON');
  }

  function showBanner(modified) {
    const b = $('banner');
    if (modified) {
      b.hidden = false;
      b.innerHTML = 'You are working on a <b>modified copy</b> of the database, saved in this browser only. ' +
        '<button class="ghost" id="banner-reset">Reset to original</button>';
      $('banner-reset').onclick = resetDb;
    } else b.hidden = true;
  }

  async function fetchOriginal() {
    const r = await fetch('oil_leaks.db');
    if (!r.ok) throw new Error('Could not load oil_leaks.db (HTTP ' + r.status + ')');
    return new Uint8Array(await r.arrayBuffer());
  }

  async function openDb() {
    let saved = null;
    try { saved = localStorage.getItem(STORE_KEY); } catch (e) { /* ignore */ }
    if (saved) {
      try {
        db = new SQL.Database(base64ToBytes(saved));
        db.exec('SELECT count(*) FROM sqlite_master');
        db.run('PRAGMA foreign_keys = ON');
        showBanner(true);
        return;
      } catch (e) { try { localStorage.removeItem(STORE_KEY); } catch (_) { /* ignore */ } }
    }
    db = new SQL.Database(await fetchOriginal());
    db.run('PRAGMA foreign_keys = ON');
    showBanner(false);
  }

  async function resetDb() {
    if (!confirm('Discard all your changes and restore the original database?')) return;
    try { localStorage.removeItem(STORE_KEY); } catch (e) { /* ignore */ }
    db = new SQL.Database(await fetchOriginal());
    db.run('PRAGMA foreign_keys = ON');
    showBanner(false);
    dirty = true;
    renderObjects();
    renderSchema();
    $('results').innerHTML = '<div class="res"><div class="msg ok">Database reset to the original data.</div></div>';
    if (currentTab() === 'explore') refreshExplore();
  }

  /* ---------- tabs ---------- */

  function currentTab() {
    const t = document.querySelector('.tabs [aria-selected="true"]');
    return t ? t.dataset.tab : 'explore';
  }

  function showTab(name) {
    document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
    document.querySelectorAll('.tab').forEach((s) => { s.hidden = s.id !== 'tab-' + name; });
    if (name === 'explore') { refreshExplore(); setTimeout(() => map && map.invalidateSize(), 50); }
    if (name === 'schema') renderSchema();
    if (name === 'sql') renderObjects();
    if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
  }

  /* ---------- explore ---------- */

  function refreshExplore() {
    try {
      all = query('SELECT * FROM v_incident_details');
    } catch (e) {
      $('stats').innerHTML = '<div class="stat"><b>!</b><span>The explorer needs the view v_incident_details and the tables it uses. Use Reset database in the SQL Lab to restore them.</span></div>';
      return;
    }
    fillSelect('f-env', 'environment', 'All environments');
    fillSelect('f-src', 'source_type', 'All sources');
    fillSelect('f-cause', 'cause', 'All causes');
    dirty = false;
    renderExplore();
  }

  function fillSelect(id, col, label) {
    const sel = $(id), cur = sel.value;
    const vals = [...new Set(all.map((r) => r[col]).filter((v) => v != null))].sort();
    sel.innerHTML = '<option value="">' + label + '</option>' + vals.map((v) => '<option value="' + esc(v) + '">' + esc(pretty(v)) + '</option>').join('');
    sel.value = vals.includes(cur) ? cur : '';
  }

  function filtered() {
    const q = state.q.trim().toLowerCase();
    return all.filter((r) =>
      (!state.env || r.environment === state.env) &&
      (!state.src || r.source_type === state.src) &&
      (!state.cause || r.cause === state.cause) &&
      (!state.from || r.year >= +state.from) &&
      (!state.to || r.year <= +state.to) &&
      (!state.known || r.volume_barrels != null) &&
      (!q || [r.name, r.location_name, r.country].join(' ').toLowerCase().includes(q)));
  }

  function renderExplore() {
    const rows = filtered();
    const barrels = rows.reduce((s, r) => s + (r.volume_barrels || 0), 0);
    const deaths = rows.reduce((s, r) => s + (r.fatalities || 0), 0);
    const countries = new Set(rows.map((r) => r.country)).size;
    $('stats').innerHTML = [
      [rows.length, 'incidents'], [countries, 'countries'], [fmt(barrels), 'barrels spilled (known)'], [fmt(deaths), 'lives lost']
    ].map(([n, l]) => '<div class="stat"><b>' + n + '</b><span>' + l + '</span></div>').join('');
    $('count').textContent = '(' + rows.length + ')';
    renderMap(rows);
    renderCharts(rows);
    renderTable(rows);
  }

  function renderMap(rows) {
    if (!map) {
      map = L.map('map', { worldCopyJump: true, minZoom: 1 }).setView([20, 10], 2);
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© OpenStreetMap contributors' }).addTo(map);
      layer = L.layerGroup().addTo(map);
      $('legend').innerHTML = Object.entries(ENV_COLORS).map(([k, c]) => '<li><i style="background:' + c + '"></i>' + k + '</li>').join('');
    }
    layer.clearLayers();
    rows.forEach((r) => {
      const radius = r.volume_barrels ? 5 + 3.4 * Math.max(0, Math.log10(r.volume_barrels / 1000)) : 5;
      const m = L.circleMarker([r.latitude, r.longitude], {
        radius, color: ENV_COLORS[r.environment] || '#fff', weight: 2, fillOpacity: r.volume_barrels ? 0.35 : 0.08,
        dashArray: r.volume_barrels ? null : '3 3'
      });
      m.bindPopup(popupHtml(r));
      m._id = r.incident_id;
      m.addTo(layer);
    });
  }

  function popupHtml(r) {
    return '<h4>' + esc(r.name) + '</h4><p>' + esc(r.incident_date) + ' · ' + esc(r.country) + '<br>' + esc(r.location_name) + '</p>' +
      '<p>Volume: <b>' + (r.volume_barrels != null ? fmt(r.volume_barrels) + ' bbl' : 'unknown') + '</b> (' + esc(r.volume_confidence) + ' confidence)<br>' +
      'Cause: ' + esc(r.cause) + ' · Source: ' + esc(pretty(r.source_type)) + '<br>Fatalities: ' + r.fatalities + ' · Status: ' + esc(r.status) + '</p>' +
      (r.summary ? '<p>' + esc(r.summary) + '</p>' : '');
  }

  function renderCharts(rows) {
    const decades = {};
    rows.forEach((r) => { const d = Math.floor(r.year / 10) * 10; decades[d] = (decades[d] || 0) + 1; });
    const dk = Object.keys(decades).map(Number).sort((a, b) => a - b);
    const dmax = Math.max(1, ...Object.values(decades));
    $('chart-decade').innerHTML = dk.length ? dk.map((d) =>
      '<div class="vbar" title="' + d + 's: ' + decades[d] + '"><em>' + decades[d] + '</em><div style="height:' + (decades[d] / dmax * 100) + '%"></div><span>' + String(d).slice(2) + 's</span></div>').join('')
      : '<span class="muted small">No data</span>';
    const causes = {};
    rows.forEach((r) => { causes[r.cause] = (causes[r.cause] || 0) + 1; });
    const ck = Object.entries(causes).sort((a, b) => b[1] - a[1]);
    const cmax = ck.length ? ck[0][1] : 1;
    $('chart-cause').innerHTML = ck.length ? ck.map(([c, n]) =>
      '<div class="hrow"><span class="name" title="' + esc(c) + '">' + esc(c) + '</span><div class="bar" style="width:' + (n / cmax * 100) + '%"></div><b>' + n + '</b></div>').join('')
      : '<span class="muted small">No data</span>';
  }

  const COLS = [
    ['name', 'Name'], ['incident_date', 'Date'], ['country', 'Country'], ['environment', 'Environment'],
    ['source_type', 'Source'], ['cause', 'Cause'], ['volume_barrels', 'Barrels', true], ['fatalities', 'Deaths', true], ['status', 'Status']
  ];

  function renderTable(rows) {
    const dir = state.dir === 'asc' ? 1 : -1;
    rows = rows.slice().sort((a, b) => {
      const x = a[state.sort], y = b[state.sort];
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return (x < y ? -1 : x > y ? 1 : 0) * dir;
    });
    const head = '<thead><tr>' + COLS.map(([k, l, num]) =>
      '<th data-col="' + k + '" class="' + (num ? 'num' : '') + '">' + l + (state.sort === k ? (state.dir === 'asc' ? ' ▲' : ' ▼') : '') + '</th>').join('') + '</tr></thead>';
    const body = '<tbody>' + rows.map((r) => '<tr data-id="' + r.incident_id + '">' + COLS.map(([k, , num]) => {
      const v = r[k];
      if (v == null) return '<td class="null ' + (num ? 'num' : '') + '">unknown</td>';
      if (k === 'environment') return '<td><span class="tag ' + esc(v) + '">' + esc(v) + '</span></td>';
      if (k === 'source_type') return '<td>' + esc(pretty(v)) + '</td>';
      if (k === 'volume_barrels') return '<td class="num">' + fmt(v) + '</td>';
      return '<td class="' + (num ? 'num' : '') + '">' + esc(v) + '</td>';
    }).join('') + '</tr>').join('') + '</tbody>';
    $('incidents').innerHTML = head + body;
    $('incidents').querySelectorAll('th').forEach((th) => th.onclick = () => {
      const c = th.dataset.col;
      state.dir = state.sort === c && state.dir === 'desc' ? 'asc' : 'desc';
      state.sort = c;
      renderTable(filtered());
    });
    $('incidents').querySelectorAll('tbody tr').forEach((tr) => tr.onclick = () => focusIncident(+tr.dataset.id));
  }

  function focusIncident(id) {
    const r = all.find((x) => x.incident_id === id);
    if (!r) return;
    map.flyTo([r.latitude, r.longitude], 5, { duration: 0.8 });
    layer.eachLayer((l) => { if (l._id === id) l.openPopup(); });
    $('map').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function bindFilters() {
    const map_ = { 'f-q': 'q', 'f-env': 'env', 'f-src': 'src', 'f-cause': 'cause', 'f-from': 'from', 'f-to': 'to' };
    Object.entries(map_).forEach(([id, key]) => $(id).addEventListener('input', (e) => { state[key] = e.target.value; renderExplore(); }));
    $('f-known').addEventListener('change', (e) => { state.known = e.target.checked; renderExplore(); });
    $('f-reset').onclick = () => {
      Object.assign(state, { q: '', env: '', src: '', cause: '', from: '', to: '', known: false });
      ['f-q', 'f-env', 'f-src', 'f-cause', 'f-from', 'f-to'].forEach((id) => { $(id).value = ''; });
      $('f-known').checked = false;
      renderExplore();
    };
  }

  /* ---------- SQL lab ---------- */

  const EDIT_EXAMPLES = [
    ['Insert a new incident', "INSERT INTO incident\n  (name, incident_date, country_id, location_name, latitude, longitude,\n   environment, source_type, cause_id, volume_barrels, volume_confidence, fatalities, status, summary)\nVALUES\n  ('My test spill', '2024-05-01', 1, 'Somewhere, USA', 29.76, -95.37,\n   'land', 'pipeline', 4, 1200, 'low', 0, 'closed', 'Added from the SQL Lab');\n\nSELECT * FROM incident ORDER BY incident_id DESC LIMIT 1;"],
    ['Update rows', "UPDATE incident\nSET status = 'closed', volume_confidence = 'medium'\nWHERE name = 'Taylor Energy platform leak';\n\nSELECT name, status, volume_confidence FROM incident WHERE name LIKE 'Taylor%';"],
    ['Delete rows (watch the audit table)', "DELETE FROM incident WHERE name = 'Montara oil spill';\n\nSELECT * FROM incident_audit;"],
    ['ALTER TABLE: add a column', "ALTER TABLE incident ADD COLUMN cleanup_cost_usd INTEGER;\n\nUPDATE incident SET cleanup_cost_usd = 65000000000 WHERE name = 'Deepwater Horizon';\n\nSELECT name, cleanup_cost_usd FROM incident WHERE cleanup_cost_usd IS NOT NULL;"],
    ['ALTER TABLE: rename a column', "ALTER TABLE incident RENAME COLUMN summary TO description;\n\nSELECT name, description FROM incident LIMIT 3;"],
    ['CREATE TABLE with a foreign key', "CREATE TABLE cleanup_operation (\n  operation_id INTEGER PRIMARY KEY AUTOINCREMENT,\n  incident_id  INTEGER NOT NULL REFERENCES incident(incident_id) ON DELETE CASCADE,\n  method       TEXT NOT NULL,\n  started_on   TEXT\n);\n\nINSERT INTO cleanup_operation (incident_id, method, started_on)\nVALUES (1, 'Controlled burning', '2010-04-28'), (1, 'Chemical dispersants', '2010-04-22');\n\nSELECT i.name, c.method, c.started_on\nFROM cleanup_operation c JOIN incident i ON i.incident_id = c.incident_id;"],
    ['CREATE VIEW', "CREATE VIEW v_big_spills AS\nSELECT name, incident_date, country, volume_barrels\nFROM v_incident_details\nWHERE volume_barrels >= 1000000;\n\nSELECT * FROM v_big_spills ORDER BY volume_barrels DESC;"],
    ['CREATE INDEX + EXPLAIN', "CREATE INDEX idx_incident_name ON incident(name);\n\nEXPLAIN QUERY PLAN\nSELECT * FROM incident WHERE name = 'Exxon Valdez';"],
    ['DROP TABLE', "DROP TABLE IF EXISTS cleanup_operation;"]
  ];
  const CONCEPT_EXAMPLES = [
    ['Transaction: ROLLBACK undoes changes', "BEGIN;\nDELETE FROM incident_impact;\nSELECT COUNT(*) AS rows_inside_transaction FROM incident_impact;\nROLLBACK;\nSELECT COUNT(*) AS rows_after_rollback FROM incident_impact;"],
    ['Constraint: foreign key violation', "-- country 1 is referenced by incidents, so this must fail\nDELETE FROM country WHERE country_id = 1;"],
    ['Constraint: CHECK violation', "-- latitude must be between -90 and 90\nINSERT INTO incident (name, incident_date, country_id, location_name, latitude, longitude, environment, source_type, cause_id)\nVALUES ('Bad row', '2020-01-01', 1, 'Nowhere', 123.4, 0, 'land', 'pipeline', 1);"],
    ['Trigger: future dates are rejected', "INSERT INTO incident (name, incident_date, country_id, location_name, latitude, longitude, environment, source_type, cause_id)\nVALUES ('Future spill', '2999-01-01', 1, 'Nowhere', 0, 0, 'land', 'pipeline', 1);"],
    ['Schema: list everything', "SELECT type, name, tbl_name FROM sqlite_master ORDER BY type, name;"]
  ];

  async function loadSampleQueries() {
    try {
      const txt = await (await fetch('queries.sql')).text();
      sampleQueries = txt.split(/\n(?=-- Q\d+:)/).map((s) => s.trim()).filter((s) => /^-- Q\d+:/.test(s))
        .map((s) => [s.split('\n')[0].replace(/^-- /, ''), s]);
    } catch (e) { sampleQueries = []; }
    const opt = (list) => list.map(([t], i) => '<option value="' + i + '">' + esc(t) + '</option>').join('');
    const g = (label, arr, key) => '<optgroup label="' + label + '">' + arr.map(([t], i) => '<option value="' + key + i + '">' + esc(t) + '</option>').join('') + '</optgroup>';
    $('examples').innerHTML = '<option value="">Load an example…</option>' + g('Read data (SELECT)', sampleQueries, 'q') +
      g('Change data and tables', EDIT_EXAMPLES, 'e') + g('DBMS concepts', CONCEPT_EXAMPLES, 'c');
    $('examples').onchange = (e) => {
      const v = e.target.value;
      if (!v) return;
      const src = { q: sampleQueries, e: EDIT_EXAMPLES, c: CONCEPT_EXAMPLES }[v[0]];
      const item = src[+v.slice(1)];
      $('sql').value = item[1];
      e.target.value = '';
      $('sql').focus();
    };
    $('sql').value = sampleQueries.length ? sampleQueries[0][1] : 'SELECT * FROM incident;';
  }

  function renderObjects() {
    const objs = query("SELECT type, name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type DESC, name");
    $('objects').innerHTML = objs.map((o) => {
      let cols = [];
      try { cols = query('PRAGMA table_info("' + o.name.replace(/"/g, '""') + '")'); } catch (e) { /* ignore */ }
      return '<div class="obj"><button data-name="' + esc(o.name) + '">' + esc(o.name) + '</button><span class="kind">' + o.type + '</span><ul>' +
        cols.map((c) => '<li>' + esc(c.name) + '</li>').join('') + '</ul></div>';
    }).join('');
    $('objects').querySelectorAll('button').forEach((b) => b.onclick = () => {
      $('sql').value = 'SELECT * FROM ' + b.dataset.name + ' LIMIT 50;';
      runSql();
    });
  }

  const MUTATES = /^\s*(insert|update|delete|replace|create|drop|alter|pragma\s+foreign_keys|commit|end|vacuum|reindex)\b/i;

  function runSql() {
    const sql = $('sql').value;
    const out = $('results');
    out.innerHTML = '';
    if (!sql.trim()) return;
    let mutated = false;
    const t0 = performance.now();
    try {
      for (const stmt of db.iterateStatements(sql)) {
        const text = stmt.getSQL().trim();
        const cols = stmt.getColumnNames();
        if (cols.length) {
          const rows = [];
          while (stmt.step()) rows.push(stmt.get());
          out.appendChild(rowsResult(text, cols, rows));
        } else {
          stmt.step();
          const dml = /^\s*(insert|update|delete|replace)\b/i.test(text);
          out.appendChild(okResult(text, dml ? db.getRowsModified() : null));
        }
        if (MUTATES.test(text)) mutated = true;
      }
    } catch (e) {
      const d = document.createElement('div');
      d.className = 'res err';
      d.innerHTML = '<header><span>Error</span></header><div class="msg">' + esc(e.message || e) + '</div>' +
        (/foreign key/i.test(e.message) ? '<div class="msg muted">Foreign keys are enforced (PRAGMA foreign_keys = ON).</div>' : '');
      out.appendChild(d);
      // statements that ran before the error may have changed data
      mutated = true;
    }
    const ms = Math.round(performance.now() - t0);
    const foot = document.createElement('p');
    foot.className = 'muted small';
    foot.textContent = 'Finished in ' + ms + ' ms';
    out.appendChild(foot);
    if (mutated) {
      dirty = true;
      persist();
      renderObjects();
      renderSchema();
    }
  }

  function rowsResult(text, cols, rows) {
    const wrap = document.createElement('div');
    wrap.className = 'res';
    const shown = rows.slice(0, 500);
    wrap.innerHTML = '<header><code>' + esc(text.split('\n')[0]) + '</code><span>' + rows.length + ' row' + (rows.length === 1 ? '' : 's') +
      (rows.length > 500 ? ' (showing 500)' : '') + '</span></header><div class="scroll"><table><thead><tr>' +
      cols.map((c) => '<th>' + esc(c) + '</th>').join('') + '</tr></thead><tbody>' +
      shown.map((r) => '<tr>' + r.map((v) => v == null ? '<td class="null">NULL</td>' :
        '<td class="' + (typeof v === 'number' ? 'num' : '') + '">' + esc(typeof v === 'number' ? v : v) + '</td>').join('') + '</tr>').join('') +
      '</tbody></table></div>';
    return wrap;
  }

  function okResult(text, changes) {
    const wrap = document.createElement('div');
    wrap.className = 'res';
    wrap.innerHTML = '<header><code>' + esc(text.split('\n')[0]) + '</code><span>OK</span></header><div class="msg ok">' +
      (changes != null ? changes + ' row' + (changes === 1 ? '' : 's') + ' affected' : 'Statement executed') + '</div>';
    return wrap;
  }

  function exportDb() {
    const blob = new Blob([db.export()], { type: 'application/octet-stream' });
    db.run('PRAGMA foreign_keys = ON');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'oil_leaks_modified.db';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  /* ---------- schema view ---------- */

  function renderSchema() {
    if (!db) return;
    const objs = query("SELECT type, name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type DESC, name");
    $('schema-cards').innerHTML = objs.map((o) => {
      const q = '"' + o.name.replace(/"/g, '""') + '"';
      let cols = [], fks = [];
      try { cols = query('PRAGMA table_info(' + q + ')'); fks = o.type === 'table' ? query('PRAGMA foreign_key_list(' + q + ')') : []; } catch (e) { /* ignore */ }
      const fkMap = Object.fromEntries(fks.map((f) => [f.from, f.table + '.' + f.to]));
      return '<div class="tcard"><h4>' + esc(o.name) + '<small>' + o.type + '</small></h4><ul>' + cols.map((c) =>
        '<li><span>' + (c.pk ? '<span class="pk" title="primary key">PK </span>' : '') + (fkMap[c.name] ? '<span class="fk" title="foreign key">FK </span>' : '') + esc(c.name) +
        (fkMap[c.name] ? ' <span class="fk">→ ' + esc(fkMap[c.name]) + '</span>' : '') + '</span><span class="t">' + esc(c.type || '') + (c.notnull ? ' NOT NULL' : '') + '</span></li>').join('') + '</ul></div>';
    }).join('');
  }

  /* ---------- boot ---------- */

  async function boot() {
    try {
      SQL = await initSqlJs({ locateFile: (f) => 'vendor/' + f });
      await openDb();
    } catch (e) {
      $('loading').textContent = 'Failed to load the database: ' + e.message + '. If you opened this file directly, serve it over HTTP (python -m http.server).';
      return;
    }
    $('loading').hidden = true;
    bindFilters();
    await loadSampleQueries();
    document.querySelectorAll('.tabs button').forEach((b) => b.onclick = () => showTab(b.dataset.tab));
    $('run').onclick = runSql;
    $('reset').onclick = resetDb;
    $('export').onclick = exportDb;
    $('sql').addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runSql(); }
      if (e.key === 'Tab') {
        e.preventDefault();
        const t = e.target, s = t.selectionStart;
        t.value = t.value.slice(0, s) + '  ' + t.value.slice(t.selectionEnd);
        t.selectionStart = t.selectionEnd = s + 2;
      }
    });
    const start = (location.hash || '#explore').slice(1);
    showTab(['explore', 'sql', 'schema', 'about'].includes(start) ? start : 'explore');
    window.__oilLeaks = { query, runSql }; // handy for debugging in the console
  }

  boot();
})();
