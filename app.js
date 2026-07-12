'use strict';

/* ================= Config ================= */
const CONFIG = {
  owner: 'LoreFishe',
  repo: 'allergy-tracker-data',
  branch: 'main',
};
const TOKEN_KEY = 'at_pat';

const ENV_HEADERS = ['date','location_name','temp_c','humidity_pct','wind_kph','pm2_5','pm10','aqi_european','pollen_tree','pollen_grass','pollen_weed','source_weather','source_pollen','fetched_at_utc'];
const SYMPTOM_HEADERS = ['date','time','location_name','severity_0_5','symptoms','dog_contact','cat_contact','dust_exposure','laser_cut_exposure','laser_cut_material','antihistamine_taken','antihistamine_name','sleep_hours','notes'];
const LOCATION_HEADERS = ['name','lat','lon','active'];

const SYMPTOM_VOCAB = [
  { key: 'sneezing', label: 'Sneezing' },
  { key: 'itchy_eyes', label: 'Itchy eyes' },
  { key: 'congestion', label: 'Congestion' },
  { key: 'sinus_pressure', label: 'Sinus pressure' },
  { key: 'fatigue', label: 'Fatigue' },
];
const SEVERITY_WORDS = ['Clear','Mild','Noticeable','Rough','Bad','Severe'];

/* ================= State ================= */
const state = {
  locations: [],
  environmental: [],
  symptoms: [],
  selectedLocation: null,
  selectedSeverity: null,
  activeSymptoms: new Set(),
  exposure: new Set(),
  antihistamineTaken: false,
  laserCutExposure: false,
};

/* ================= Token ================= */
function getToken(){ return localStorage.getItem(TOKEN_KEY) || ''; }
function setToken(t){ localStorage.setItem(TOKEN_KEY, t); }

/* ================= CSV ================= */
function parseCSV(text){
  const rows = [];
  let i = 0, field = '', row = [], inQuotes = false;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i+1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  while (rows.length && rows[rows.length-1].length === 1 && rows[rows.length-1][0] === '') rows.pop();
  if (!rows.length) return { headers: [], records: [] };
  const headers = rows[0];
  const records = rows.slice(1).map(r => {
    const obj = {};
    headers.forEach((h, idx) => obj[h] = r[idx] !== undefined ? r[idx] : '');
    return obj;
  });
  return { headers, records };
}
function csvField(v){
  const s = (v === null || v === undefined) ? '' : String(v);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g,'""') + '"';
  return s;
}
function stringifyCSV(headers, records){
  const lines = [headers.join(',')];
  records.forEach(r => lines.push(headers.map(h => csvField(r[h])).join(',')));
  return lines.join('\n') + '\n';
}

/* ================= GitHub Contents API ================= */
function b64EncodeUtf8(str){ return btoa(unescape(encodeURIComponent(str))); }
function b64DecodeUtf8(str){ return decodeURIComponent(escape(atob(str.replace(/\n/g, '')))); }

async function ghGet(path){
  const res = await fetch(`https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}/contents/${path}?ref=${CONFIG.branch}`, {
    headers: { Authorization: `Bearer ${getToken()}`, Accept: 'application/vnd.github+json' },
  });
  if (res.status === 404) return { content: '', sha: null };
  if (!res.ok) throw new Error(`GitHub GET ${path} failed: ${res.status}`);
  const data = await res.json();
  return { content: b64DecodeUtf8(data.content), sha: data.sha };
}

async function ghPut(path, content, sha, message){
  const body = { message, content: b64EncodeUtf8(content), branch: CONFIG.branch };
  if (sha) body.sha = sha;
  const res = await fetch(`https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}/contents/${path}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${getToken()}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`GitHub PUT ${path} failed: ${res.status} ${text}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/** Fetch a CSV, apply `mutate(records)` to its records array in place, write it back. Retries once on sha conflict. */
async function updateCSV(path, headers, mutate, message){
  for (let attempt = 0; attempt < 2; attempt++) {
    const { content, sha } = await ghGet(path);
    const parsed = parseCSV(content);
    const hdrs = parsed.headers.length ? parsed.headers : headers;
    const records = parsed.records.slice();
    mutate(records);
    const newContent = stringifyCSV(hdrs, records);
    try {
      await ghPut(path, newContent, sha, message);
      return records;
    } catch (e) {
      if (e.status === 409 && attempt === 0) continue;
      throw e;
    }
  }
}

/* ================= Date helpers ================= */
function todayISO(){
  const d = new Date();
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}
function nowTimeHM(){
  const d = new Date();
  return String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
}
function addDaysISO(iso, delta){
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}
function daysBetween(startISO, endISO){
  const a = new Date(startISO + 'T00:00:00Z');
  const b = new Date(endISO + 'T00:00:00Z');
  return Math.round((b - a) / 86400000);
}

/* ================= Geocoding ================= */
async function geocodePlace(place){
  const m = place.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (m) return { lat: parseFloat(m[1]), lon: parseFloat(m[2]) };
  const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=1`);
  const data = await res.json();
  if (!data.results || !data.results.length) throw new Error(`Could not find a location for "${place}"`);
  return { lat: data.results[0].latitude, lon: data.results[0].longitude };
}

/* ================= Open-Meteo weather/AQI ================= */
function mean(arr){ return arr.length ? arr.reduce((a,b)=>a+b,0) / arr.length : null; }
function round1(n){ return n === null || n === undefined ? '' : Math.round(n * 10) / 10; }

async function fetchEnvRange(loc, startDate, endDate){
  const pastDays = Math.min(92, Math.max(0, daysBetween(startDate, todayISO())));
  const [wRes, aRes] = await Promise.all([
    fetch(`https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&hourly=temperature_2m,relative_humidity_2m,wind_speed_10m&timezone=auto&past_days=${pastDays}&forecast_days=1`),
    fetch(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${loc.lat}&longitude=${loc.lon}&hourly=pm2_5,pm10,european_aqi&timezone=auto&past_days=${pastDays}&forecast_days=1`),
  ]);
  if (!wRes.ok) throw new Error(`Open-Meteo forecast failed: ${wRes.status}`);
  if (!aRes.ok) throw new Error(`Open-Meteo air-quality failed: ${aRes.status}`);
  const w = await wRes.json();
  const a = await aRes.json();

  const byDate = {};
  const ensure = (d) => byDate[d] || (byDate[d] = { temp: [], hum: [], wind: [], pm25: [], pm10: [], aqi: [] });
  (w.hourly.time || []).forEach((t, i) => {
    const d = t.slice(0, 10);
    const bucket = ensure(d);
    const temp = w.hourly.temperature_2m[i];
    const hum = w.hourly.relative_humidity_2m[i];
    const wind = w.hourly.wind_speed_10m[i];
    if (temp != null) bucket.temp.push(temp);
    if (hum != null) bucket.hum.push(hum);
    if (wind != null) bucket.wind.push(wind);
  });
  (a.hourly.time || []).forEach((t, i) => {
    const d = t.slice(0, 10);
    const bucket = ensure(d);
    const pm25 = a.hourly.pm2_5[i];
    const pm10 = a.hourly.pm10[i];
    const aqi = a.hourly.european_aqi[i];
    if (pm25 != null) bucket.pm25.push(pm25);
    if (pm10 != null) bucket.pm10.push(pm10);
    if (aqi != null) bucket.aqi.push(aqi);
  });

  const rows = [];
  const fetchedAt = new Date().toISOString();
  Object.keys(byDate).sort().forEach((d) => {
    if (d < startDate || d > endDate) return;
    const b = byDate[d];
    rows.push({
      date: d,
      location_name: loc.name,
      temp_c: round1(mean(b.temp)),
      humidity_pct: round1(mean(b.hum)),
      wind_kph: round1(mean(b.wind)),
      pm2_5: round1(mean(b.pm25)),
      pm10: round1(mean(b.pm10)),
      aqi_european: b.aqi.length ? Math.round(mean(b.aqi)) : '',
      pollen_tree: '',
      pollen_grass: '',
      pollen_weed: '',
      source_weather: 'open-meteo',
      source_pollen: '',
      fetched_at_utc: fetchedAt,
    });
  });
  return rows;
}

/* ================= Backfill ================= */
// Weather/AQI (this function) and pollen (the local script) can each create a
// row for a given date+location independently. Always merge by (date,
// location) rather than skip-if-exists, so whichever side runs first doesn't
// block the other from filling in its columns later.
async function runBackfill(){
  const activeLocations = state.locations.filter(l => l.active === 'true' || l.active === true);
  if (!activeLocations.length) return;
  setGlobalStatus('Checking for missing environmental data…');
  let fetchedRows = [];
  for (const loc of activeLocations) {
    try {
      const existingForLoc = state.environmental.filter(r => r.location_name === loc.name);
      const weatherDates = existingForLoc.filter(r => r.source_weather).map(r => r.date);
      const today = todayISO();
      const startDate = weatherDates.length === 0 ? addDaysISO(today, -30) : addDaysISO(weatherDates.sort().slice(-1)[0], 1);
      if (startDate > today) continue;
      const rows = await fetchEnvRange(loc, startDate, today);
      fetchedRows = fetchedRows.concat(rows);
    } catch (e) {
      console.error('Backfill failed for', loc.name, e);
    }
  }
  if (!fetchedRows.length) { clearGlobalStatus(); return; }
  setGlobalStatus(`Saving ${fetchedRows.length} day(s) of weather/AQI data…`);
  const updatedRecords = await updateCSV('environmental.csv', ENV_HEADERS, (records) => {
    const byKey = {};
    records.forEach(r => byKey[r.location_name + '|' + r.date] = r);
    fetchedRows.forEach(row => {
      const key = row.location_name + '|' + row.date;
      const existing = byKey[key];
      if (existing) {
        Object.assign(existing, {
          temp_c: row.temp_c, humidity_pct: row.humidity_pct, wind_kph: row.wind_kph,
          pm2_5: row.pm2_5, pm10: row.pm10, aqi_european: row.aqi_european,
          source_weather: row.source_weather, fetched_at_utc: row.fetched_at_utc,
        });
      } else {
        records.push(row);
        byKey[key] = row;
      }
    });
  }, `Backfill environmental data (${fetchedRows.length} row(s))`);
  state.environmental = updatedRecords;
  clearGlobalStatus();
}

/* ================= Global status ================= */
function setGlobalStatus(msg){
  const el = document.getElementById('globalStatus');
  el.textContent = msg;
  el.style.display = '';
}
function clearGlobalStatus(){
  const el = document.getElementById('globalStatus');
  el.style.display = 'none';
}

/* ================= Rendering: locations ================= */
function renderLocationSelects(){
  const active = state.locations.filter(l => l.active === 'true' || l.active === true);
  const headerSel = document.getElementById('locationSelect');
  const entrySel = document.getElementById('entryLocationSelect');
  const prevHeader = state.selectedLocation;

  headerSel.innerHTML = '';
  active.forEach(l => {
    const opt = document.createElement('option');
    opt.value = l.name; opt.textContent = l.name;
    headerSel.appendChild(opt);
  });
  if (active.some(l => l.name === prevHeader)) headerSel.value = prevHeader;
  else if (active.length) headerSel.value = active[0].name;
  state.selectedLocation = headerSel.value || null;

  entrySel.innerHTML = '';
  active.forEach(l => {
    const opt = document.createElement('option');
    opt.value = l.name; opt.textContent = l.name;
    entrySel.appendChild(opt);
  });
  const addOpt = document.createElement('option');
  addOpt.value = '__new__'; addOpt.textContent = '+ Add new location…';
  entrySel.appendChild(addOpt);
  if (state.selectedLocation) entrySel.value = state.selectedLocation;
}

/* ================= Rendering: env snapshot ================= */
function aqiClass(aqi){
  if (aqi === '' || aqi === null || aqi === undefined) return '';
  const v = Number(aqi);
  if (v <= 40) return '';
  if (v <= 60) return 'moderate';
  return 'poor';
}
function aqiLabel(aqi){
  const v = Number(aqi);
  if (v <= 20) return 'Good';
  if (v <= 40) return 'Fair';
  if (v <= 60) return 'Moderate';
  if (v <= 80) return 'Poor';
  return 'Very poor';
}
// pollen_* columns store Google's Universal Pollen Index (UPI), an integer 0-5 scale.
const UPI_LABELS = ['None', 'Very Low', 'Low', 'Moderate', 'High', 'Very High'];
function pollenLabel(v){
  if (v === '' || v === null || v === undefined) return null;
  const n = Math.round(Number(v));
  return UPI_LABELS[Math.max(0, Math.min(5, n))];
}

function renderEnvSnapshot(){
  const loc = state.selectedLocation;
  document.getElementById('envTitle').textContent = loc ? `${loc} — conditions today` : 'Conditions today';
  const body = document.getElementById('envBody');
  const today = todayISO();
  const row = state.environmental.find(r => r.location_name === loc && r.date === today);
  if (!row) {
    body.innerHTML = '<div class="env-empty">No environmental data yet for today — it fills in automatically on load.</div>';
    return;
  }
  const hasPollen = row.pollen_tree !== '' || row.pollen_grass !== '' || row.pollen_weed !== '';
  let html = '';
  if (hasPollen) {
    html += '<div class="pollen-bars">';
    [['pollen_tree','Tree'],['pollen_grass','Grass'],['pollen_weed','Weed']].forEach(([key,label]) => {
      const v = row[key];
      const pct = v === '' ? 0 : Math.min(100, (Number(v) / 5) * 100);
      const lbl = pollenLabel(v) || 'No data';
      html += `<div class="pollen-item"><div class="meter"><div class="fill" style="height:${pct}%"></div></div><div class="name">${label}</div><div class="level">${lbl}</div></div>`;
    });
    html += '</div>';
  } else {
    html += '<div class="env-empty">Pollen: no data yet (captured by the local script, separately from this page).</div>';
  }
  const aqiCls = aqiClass(row.aqi_european);
  html += `<div class="env-row"><span class="env-label">Air quality (AQI)</span><span class="aqi-chip ${aqiCls}"><span class="dot"></span><span>${row.aqi_european || '–'} · ${row.aqi_european ? aqiLabel(row.aqi_european) : 'n/a'}</span></span></div>`;
  html += `<div class="env-row"><span class="env-label">PM2.5</span><span class="env-val">${row.pm2_5 || '–'} µg/m³</span></div>`;
  html += `<div class="env-row"><span class="env-label">Temp / Humidity</span><span class="env-val">${row.temp_c || '–'}°C / ${row.humidity_pct || '–'}%</span></div>`;
  html += `<div class="env-row"><span class="env-label">Wind</span><span class="env-val">${row.wind_kph || '–'} km/h</span></div>`;
  body.innerHTML = html;
}

/* ================= Gauge ================= */
const GAUGE_CX = 110, GAUGE_CY = 110, GAUGE_R = 80;
function angleFor(val){ return 180 - (val * 36); }
function setNeedle(val){
  const theta = angleFor(val) * Math.PI / 180;
  const x2 = GAUGE_CX + GAUGE_R * Math.cos(theta);
  const y2 = GAUGE_CY - GAUGE_R * Math.sin(theta);
  const needle = document.getElementById('needle');
  needle.setAttribute('x2', x2.toFixed(1));
  needle.setAttribute('y2', y2.toFixed(1));
}
function initGauge(){
  const ticks = document.querySelectorAll('.tick-btn');
  ticks.forEach(btn => {
    const val = parseInt(btn.dataset.val, 10);
    const theta = angleFor(val) * Math.PI / 180;
    const tr = 96;
    const px = GAUGE_CX + tr * Math.cos(theta);
    const py = GAUGE_CY - tr * Math.sin(theta);
    btn.style.left = (px / 220 * 100) + '%';
    btn.style.top = (py / 130 * 100) + '%';
    btn.addEventListener('click', () => {
      ticks.forEach(b => b.setAttribute('aria-pressed', 'false'));
      btn.setAttribute('aria-pressed', 'true');
      state.selectedSeverity = val;
      document.getElementById('severityNum').textContent = val;
      document.getElementById('severityWord').textContent = SEVERITY_WORDS[val];
      setNeedle(val);
    });
  });
}

/* ================= Symptom pills / toggles ================= */
const SYMPTOM_ICON = `<svg viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="5" fill="currentColor"/><g stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><line x1="10" y1="1" x2="10" y2="3.2"/><line x1="10" y1="16.8" x2="10" y2="19"/><line x1="1" y1="10" x2="3.2" y2="10"/><line x1="16.8" y1="10" x2="19" y2="10"/><line x1="3.9" y1="3.9" x2="5.4" y2="5.4"/><line x1="14.6" y1="14.6" x2="16.1" y2="16.1"/><line x1="16.1" y1="3.9" x2="14.6" y2="5.4"/><line x1="5.4" y1="14.6" x2="3.9" y2="16.1"/></g></svg>`;

function initSymptomPills(){
  const grid = document.getElementById('symptomGrid');
  SYMPTOM_VOCAB.forEach(s => {
    const label = document.createElement('label');
    label.className = 'symptom-pill';
    label.innerHTML = `<input type="checkbox">${SYMPTOM_ICON}${s.label}`;
    label.querySelector('input').addEventListener('change', function(){
      label.classList.toggle('active', this.checked);
      if (this.checked) state.activeSymptoms.add(s.key); else state.activeSymptoms.delete(s.key);
    });
    grid.appendChild(label);
  });
}
function initExposureToggles(){
  document.querySelectorAll('.toggle-pill[data-exp]').forEach(btn => {
    btn.addEventListener('click', () => {
      btn.classList.toggle('active');
      const exp = btn.dataset.exp;
      if (btn.classList.contains('active')) state.exposure.add(exp); else state.exposure.delete(exp);
    });
  });
}
function initAntihistamine(){
  const antiToggle = document.getElementById('antiToggle');
  const antiName = document.getElementById('antiName');
  antiToggle.addEventListener('click', () => {
    antiToggle.classList.toggle('active');
    state.antihistamineTaken = antiToggle.classList.contains('active');
    antiName.classList.toggle('visible', state.antihistamineTaken);
  });
}
function initLaserExposure(){
  const laserToggle = document.getElementById('laserToggle');
  const laserMaterial = document.getElementById('laserMaterial');
  laserToggle.addEventListener('click', () => {
    laserToggle.classList.toggle('active');
    state.laserCutExposure = laserToggle.classList.contains('active');
    laserMaterial.classList.toggle('visible', state.laserCutExposure);
  });
}

/* ================= New-location fields ================= */
function initLocationEntry(){
  const entrySel = document.getElementById('entryLocationSelect');
  const newFields = document.getElementById('newLocationFields');
  entrySel.addEventListener('change', () => {
    newFields.classList.toggle('visible', entrySel.value === '__new__');
  });
  document.getElementById('locationSelect').addEventListener('change', (e) => {
    state.selectedLocation = e.target.value;
    renderEnvSnapshot();
  });
}

/* ================= Save entry ================= */
async function addNewLocation(name, place){
  const { lat, lon } = await geocodePlace(place);
  const newLoc = { name, lat: String(lat), lon: String(lon), active: 'true' };
  await updateCSV('locations.csv', LOCATION_HEADERS, (records) => {
    records.push(newLoc);
  }, `Add location: ${name}`);
  state.locations.push(newLoc);
  const rows = await fetchEnvRange({ name, lat, lon }, addDaysISO(todayISO(), -30), todayISO());
  if (rows.length) {
    await updateCSV('environmental.csv', ENV_HEADERS, (records) => { records.push(...rows); }, `Backfill 30 days for new location: ${name}`);
    state.environmental = state.environmental.concat(rows);
  }
  return newLoc;
}

function setSaveStatus(msg, isError){
  const el = document.getElementById('saveStatus');
  el.textContent = msg;
  el.classList.toggle('error', !!isError);
  el.classList.add('visible');
  if (!isError) setTimeout(() => el.classList.remove('visible'), 3000);
}

async function handleSave(){
  const saveBtn = document.getElementById('saveBtn');
  if (state.selectedSeverity === null) {
    setSaveStatus('Pick a severity on the dial first', true);
    return;
  }
  const entrySel = document.getElementById('entryLocationSelect');
  let locationName = entrySel.value;
  saveBtn.disabled = true;
  try {
    if (locationName === '__new__') {
      const name = document.getElementById('newLocName').value.trim();
      const place = document.getElementById('newLocPlace').value.trim();
      if (!name || !place) { setSaveStatus('Enter a name and city/zip for the new location', true); saveBtn.disabled = false; return; }
      setSaveStatus('Adding location…', false);
      await addNewLocation(name, place);
      locationName = name;
      renderLocationSelects();
      document.getElementById('entryLocationSelect').value = name;
    }
    const record = {
      date: todayISO(),
      time: nowTimeHM(),
      location_name: locationName,
      severity_0_5: String(state.selectedSeverity),
      symptoms: Array.from(state.activeSymptoms).join(';'),
      dog_contact: String(state.exposure.has('dog')),
      cat_contact: String(state.exposure.has('cat')),
      dust_exposure: String(state.exposure.has('dust')),
      laser_cut_exposure: String(state.laserCutExposure),
      laser_cut_material: state.laserCutExposure ? document.getElementById('laserMaterial').value : '',
      antihistamine_taken: String(state.antihistamineTaken),
      antihistamine_name: state.antihistamineTaken ? document.getElementById('antiName').value.trim() : '',
      sleep_hours: document.getElementById('sleepInput').value || '',
      notes: document.getElementById('notesInput').value.trim(),
    };
    setSaveStatus('Saving…', false);
    await updateCSV('symptoms.csv', SYMPTOM_HEADERS, (records) => { records.push(record); }, `Log symptom entry: ${record.date}`);
    state.symptoms.push(record);
    setSaveStatus('✓ Entry saved', false);
    renderHistory();
  } catch (e) {
    console.error(e);
    setSaveStatus('Save failed — check your token and connection', true);
  } finally {
    saveBtn.disabled = false;
  }
}

/* ================= Completeness classification ================= */
function classifyLogs(){
  const envDatesByLoc = {};
  state.environmental.forEach(r => {
    (envDatesByLoc[r.location_name] || (envDatesByLoc[r.location_name] = new Set())).add(r.date);
  });
  const complete = [], incomplete = [];
  state.symptoms.forEach(log => {
    const dates = envDatesByLoc[log.location_name] || new Set();
    const windowStart = addDaysISO(log.date, -30);
    const windowEnd = addDaysISO(log.date, 30);
    let covered = 0, total = 0;
    for (let d = windowStart; d <= windowEnd; d = addDaysISO(d, 1)) {
      total++;
      if (dates.has(d)) covered++;
    }
    if (covered === total) complete.push(log);
    else incomplete.push(Object.assign({}, log, { covered, total }));
  });
  complete.sort((a, b) => a.date.localeCompare(b.date));
  incomplete.sort((a, b) => b.date.localeCompare(a.date));
  return { complete, incomplete };
}

/* ================= History rendering ================= */
function sevColor(sev){
  if (sev <= 1) return '#5F7A67';
  if (sev <= 3) return '#B8862E';
  return '#A14B3B';
}
function pollenAvg(row){
  const vals = [row.pollen_tree, row.pollen_grass, row.pollen_weed].filter(v => v !== '' && v !== undefined).map(Number);
  return vals.length ? mean(vals) : null;
}

function renderChart(completeLogs){
  const svg = document.getElementById('historyChart');
  const chartEmpty = document.getElementById('chartEmpty');
  const wrap = document.getElementById('chartWrap');
  const data = completeLogs.slice(-21);
  if (!data.length) { svg.innerHTML = ''; wrap.style.display = 'none'; chartEmpty.style.display = ''; return; }
  wrap.style.display = ''; chartEmpty.style.display = 'none';

  const envByKey = {};
  state.environmental.forEach(r => { envByKey[r.location_name + '|' + r.date] = r; });

  const W = 640, H = 180, padL = 8, padR = 8, padB = 26, padT = 10;
  const days = data.length;
  const chartW = W - padL - padR;
  const barGap = 6;
  const barW = Math.max(2, (chartW / days) - barGap);
  const maxBarH = H - padT - padB;

  const points = data.map(log => {
    const env = envByKey[log.location_name + '|' + log.date];
    return { date: log.date, sev: Number(log.severity_0_5), pollen: env ? pollenAvg(env) : null };
  });
  const maxPollen = Math.max(1, ...points.map(p => p.pollen || 0));

  let html = '';
  const pollenPoints = points.filter(p => p.pollen !== null);
  if (pollenPoints.length > 1) {
    let linePoints = '';
    points.forEach((p, i) => {
      if (p.pollen === null) return;
      const x = padL + i * (chartW / days) + (chartW / days) / 2;
      const y = padT + (1 - p.pollen / maxPollen) * (maxBarH * 0.5);
      linePoints += `${x.toFixed(1)},${y.toFixed(1)} `;
    });
    html += `<polyline points="${linePoints.trim()}" fill="none" stroke="#8B9086" stroke-width="1.5" stroke-dasharray="3,3" opacity="0.8"/>`;
    points.forEach((p, i) => {
      if (p.pollen === null) return;
      const x = padL + i * (chartW / days) + (chartW / days) / 2;
      const y = padT + (1 - p.pollen / maxPollen) * (maxBarH * 0.5);
      html += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.4" fill="#8B9086"/>`;
    });
  }

  points.forEach((p, i) => {
    const x = padL + i * (chartW / days) + barGap / 2;
    const h = Math.max(4, (p.sev / 5) * maxBarH);
    const y = H - padB - h;
    html += `<rect class="bar" data-i="${i}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="2.5" fill="${sevColor(p.sev)}" style="cursor:pointer;"/>`;
    if (i % 3 === 0) {
      const d = new Date(p.date + 'T00:00:00Z');
      const lbl = (d.getUTCMonth() + 1) + '/' + d.getUTCDate();
      html += `<text x="${(x + barW / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle" font-family="IBM Plex Mono, monospace" font-size="9" fill="#8B9086">${lbl}</text>`;
    }
  });
  svg.innerHTML = html;

  const tooltip = document.getElementById('tooltip');
  svg.querySelectorAll('.bar').forEach(bar => {
    bar.addEventListener('mousemove', (e) => {
      const i = parseInt(bar.dataset.i, 10);
      const p = points[i];
      const rect = wrap.getBoundingClientRect();
      tooltip.style.left = (e.clientX - rect.left) + 'px';
      tooltip.style.top = (e.clientY - rect.top) + 'px';
      tooltip.innerHTML = `<span class="t-date">${p.date}</span><br>Severity ${p.sev}${p.pollen !== null ? ' · Pollen ' + Math.round(p.pollen) : ''}`;
      tooltip.classList.add('visible');
    });
    bar.addEventListener('mouseleave', () => tooltip.classList.remove('visible'));
  });
}

function renderIncomplete(incompleteLogs){
  const list = document.getElementById('incompleteList');
  const empty = document.getElementById('incompleteEmpty');
  if (!incompleteLogs.length) { list.innerHTML = ''; empty.style.display = ''; return; }
  empty.style.display = 'none';
  list.innerHTML = incompleteLogs.map(log => `
    <div class="incomplete-row">
      <span class="il-date">${log.date} · ${log.location_name}</span>
      <span class="il-sev">Severity ${log.severity_0_5}</span>
      <span class="il-note">${log.covered}/${log.total} days of environmental context</span>
    </div>
  `).join('');
}

function renderHistory(){
  const { complete, incomplete } = classifyLogs();
  renderChart(complete);
  renderIncomplete(incomplete);
}

/* ================= Token modal ================= */
function initModal(){
  const backdrop = document.getElementById('modalBackdrop');
  const input = document.getElementById('tokenInput');
  const status = document.getElementById('modalStatus');
  const open = () => { status.textContent = ''; status.className = 'modal-status'; backdrop.classList.add('open'); };
  const close = () => backdrop.classList.remove('open');

  document.getElementById('settingsBtn').addEventListener('click', open);
  document.getElementById('modalClose').addEventListener('click', close);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  document.getElementById('modalSave').addEventListener('click', async () => {
    const t = input.value.trim();
    if (!t) { status.textContent = 'Paste a token first'; status.className = 'modal-status error'; return; }
    setToken(t);
    input.value = '';
    status.textContent = 'Saved. Loading your data…';
    status.className = 'modal-status ok';
    try {
      await loadAll();
      close();
    } catch (e) {
      console.error(e);
      status.textContent = 'Could not load data with that token — check it has Contents: Read/write on allergy-tracker-data.';
      status.className = 'modal-status error';
    }
  });

  if (!getToken()) open();
}

/* ================= Init / load ================= */
async function loadAll(){
  setGlobalStatus('Loading your data…');
  const [locRes, envRes, symRes] = await Promise.all([
    ghGet('locations.csv'), ghGet('environmental.csv'), ghGet('symptoms.csv'),
  ]);
  state.locations = parseCSV(locRes.content).records;
  state.environmental = parseCSV(envRes.content).records;
  state.symptoms = parseCSV(symRes.content).records;
  renderLocationSelects();
  renderEnvSnapshot();
  renderHistory();
  clearGlobalStatus();
  await runBackfill();
  renderEnvSnapshot();
  renderHistory();
}

function init(){
  initGauge();
  initSymptomPills();
  initExposureToggles();
  initAntihistamine();
  initLaserExposure();
  initLocationEntry();
  initModal();
  document.getElementById('saveBtn').addEventListener('click', handleSave);
  document.getElementById('todayLabel').textContent = 'Today · ' + todayISO();

  if (getToken()) {
    loadAll().catch(e => {
      console.error(e);
      setGlobalStatus('Could not load your data. Check your token in Settings.');
    });
  }
}

document.addEventListener('DOMContentLoaded', init);
