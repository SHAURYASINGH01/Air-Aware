(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const form = $('plannerForm');
  const aqInput = $('aqiInput');
  const historyKey = 'airaware.savedPlans.v1';
  const checklistKey = 'airaware.checklist.v1';
  let renderedAsDemo = false;
  let latestPlan = null;
  let hasLiveData = false;

  const cities = {
    'Delhi': { latitude: 28.6139, longitude: 77.2090 },
    'Noida': { latitude: 28.5355, longitude: 77.3910 },
    'Gurugram': { latitude: 28.4595, longitude: 77.0266 }
  };
  const categoryInfo = (aqi) => {
    if (aqi <= 50) return { name: 'Good', color: '#e0f2db', ink: '#33643b', message: 'The reading is in the Good band. Continue monitoring updates and follow normal campus procedures.', position: aqi / 5 };
    if (aqi <= 100) return { name: 'Satisfactory', color: '#edf1ce', ink: '#5e6c35', message: 'The reading is in the Satisfactory band. Check local guidance and consider the activity and participants before proceeding.', position: aqi / 5 };
    if (aqi <= 200) return { name: 'Moderate', color: '#fbf0c3', ink: '#796125', message: 'The reading is in the Moderate band. Review the conditions and consider practical ways to limit unnecessary outdoor exposure.', position: aqi / 5 };
    if (aqi <= 300) return { name: 'Poor', color: '#f8dfc5', ink: '#8a5725', message: 'The reading is in the Poor band. Review official guidance and consider adjusting outdoor activities or using an indoor alternative.', position: aqi / 5 };
    if (aqi <= 400) return { name: 'Very Poor', color: '#f4d6cb', ink: '#8b493a', message: 'The reading is in the Very Poor band. Give extra attention to official guidance and review whether the activity should be changed.', position: aqi / 5 };
    return { name: 'Severe', color: '#ead7df', ink: '#763d53', message: 'The reading is in the Severe band. Follow current official directions and campus safety procedures before deciding on outdoor activities.', position: aqi / 5 };
  };
  const activityNames = {
    sports: 'Outdoor sports / PE',
    assembly: 'Assembly / campus event',
    commute: 'Walking between buildings',
    maintenance: 'Outdoor maintenance'
  };
  function adviceFor(activity, aqi) {
    const high = aqi > 200;
    const veryHigh = aqi > 300;
    const advice = {
      sports: high
        ? [['🏫', 'Review an indoor alternative', 'Consider moving intense outdoor exercise indoors or changing the schedule, following official guidance.'], ['📣', 'Tell participants what changed', 'Communicate the reason, the alternative and where to check for updates.']]
        : [['🧭', 'Check before starting', 'Confirm that the reading is recent and review current local guidance.'], ['💧', 'Keep an option to pause', 'Make sure participants can stop or move indoors if conditions change.']],
      assembly: high
        ? [['🏫', 'Review the venue', 'Consider an indoor venue and follow official guidance before deciding.'], ['📣', 'Notify attendees', 'Share any venue or schedule change and the source of the update.']]
        : [['🧾', 'Confirm the reading time', 'Use a recent trusted reading close to the event time.'], ['🏫', 'Keep an alternative ready', 'Identify another venue in case conditions change.']],
      commute: high
        ? [['🗺️', 'Review route and timing', 'Consider reducing unnecessary outdoor time and follow current local guidance.'], ['📣', 'Share practical updates', 'Tell students where to find reliable readings and campus updates.']]
        : [['🧾', 'Check before leaving', 'Use a recent reading rather than relying on a saved demo value.'], ['🚶', 'Plan the route', 'Follow normal travel and campus safety procedures.']],
      maintenance: high
        ? [['🛠️', 'Review dusty outdoor work', 'Consider rescheduling dust-generating work and follow site-specific workplace safety procedures.'], ['🦺', 'Check safety controls', 'Ask the responsible supervisor to review controls appropriate for the task and conditions.']]
        : [['🦺', 'Follow site procedures', 'Use the standard controls and supervision required for the task.'], ['🧾', 'Record conditions', 'Note the reading source and time in the work plan.']]
    };
    const chosen = (advice[activity] || advice.sports).map(item => [...item]);
    if (veryHigh) chosen.push(['⚠️', 'Follow official directions', 'This prototype is not an alert system. Check CPCB and relevant local authority guidance before acting.']);
    return chosen;
  }
  function safeText(value) { return String(value ?? '').replace(/[<>]/g, ''); }
  function localDateTime() {
    const date = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
  function displayTime(value) {
    if (!value) return 'Not provided';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
  }
  function renderAdvice(activities) {
    const list = $('actionList');
    list.replaceChildren();
    activities.forEach(([icon, title, description]) => {
      const card = document.createElement('article');
      card.className = 'action';
      const iconBox = document.createElement('div');
      iconBox.className = 'action-icon'; iconBox.setAttribute('aria-hidden', 'true'); iconBox.textContent = icon;
      const copy = document.createElement('div');
      const heading = document.createElement('strong'); heading.textContent = title;
      const paragraph = document.createElement('p'); paragraph.textContent = description;
      copy.append(heading, paragraph); card.append(iconBox, copy); list.append(card);
    });
  }
  function buildPlanText(plan) {
    if (!plan) return 'Generate a plan first.';
    return [
      'AirAware — Campus Air Safety Plan',
      `Location: ${plan.location}`,
      `Indian CPCB AQI entered: ${plan.aqi} / 500`,
      `Category: ${plan.category}`,
      `Activity: ${activityNames[plan.activity] || plan.activity}`,
      `Selected reading source: ${plan.source}`,
      `Reading timestamp supplied: ${displayTime(plan.readingTime)}`,
      `Plan generated: ${displayTime(plan.createdAt)}`,
      '',
      'Suggested planning prompts:',
      ...plan.recommendations.map((rec, i) => `${i + 1}. ${rec[1]} — ${rec[2]}`),
      '',
      'Disclaimer: user-supplied/illustrative reading, not independently verified by AirAware. This is not medical advice or an official alert. Verify current CPCB and local authority guidance.'
    ].join('\n');
  }
  function renderPlan(aqi, sourceOverride, timestampOverride, shouldMessage = true) {
    const info = categoryInfo(aqi);
    const location = $('location').value;
    const activity = $('activity').value;
    const source = sourceOverride || $('source').value || 'Not selected';
    const timestamp = timestampOverride !== undefined ? timestampOverride : $('readingTime').value;
    const demo = source === 'Illustrative sample';
    renderedAsDemo = demo;
    const recommendations = adviceFor(activity, aqi);
    $('emptyState').hidden = true; $('resultContent').hidden = false;
    $('resultBadge').textContent = demo ? 'DEMO EXAMPLE' : 'USER-ENTERED';
    $('readingLocation').textContent = `${location.toUpperCase()} · ${demo ? 'ILLUSTRATIVE DEMO' : 'READING NOT VERIFIED'}`;
    $('aqiValue').textContent = String(aqi);
    $('categoryName').textContent = info.name;
    $('categoryCard').style.backgroundColor = info.color; $('categoryCard').style.color = info.ink;
    $('categoryMessage').textContent = info.message;
    $('scaleMarker').style.left = `${Math.max(0, Math.min(100, info.position))}%`;
    $('scaleMarker').setAttribute('aria-label', `AQI ${aqi} on a scale from 0 to 500`);
    $('activityTitle').textContent = activityNames[activity] || activityNames.sports;
    const srcText = `Selected source: ${source}. Reading timestamp: ${displayTime(timestamp)}. AirAware cannot independently verify either detail. `;
    $('readingDisclaimer').textContent = (demo ? 'This is an illustrative example, not a current city measurement. ' : srcText) + 'This is a suggested planning aid, not an official alert or medical advice. Verify the current CPCB reading and local guidance before acting.';
    renderAdvice(recommendations);
    $('formError').textContent = demo ? 'Demo only: AQI 168 is an example value, not live data.' : 'Plan created. Verify the reading source, timestamp and official guidance before using it.';
    $('formError').style.color = demo ? '#8b5b17' : '#527b4c';
    $('resultTitle').textContent = 'Your plan starts here.';
    latestPlan = { location, aqi, category: info.name, activity, source, readingTime: timestamp || '', createdAt: new Date().toISOString(), recommendations };
    if (shouldMessage) $('planToolsStatus').textContent = '';
    return latestPlan;
  }
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const raw = aqInput.value.trim(); const value = Number(raw); const source = $('source').value; const timestamp = $('readingTime').value;
    if (raw === '' || !Number.isInteger(value) || value < 0 || value > 500) {
      $('formError').textContent = 'Enter a whole-number AQI from 0 to 500, or try the demo example.'; $('formError').style.color = '#a14636'; aqInput.focus(); return;
    }
    if (!source) { $('formError').textContent = 'Choose where you got the reading, then generate your plan.'; $('formError').style.color = '#a14636'; $('source').focus(); return; }
    if (source !== 'Illustrative sample' && !timestamp) { $('formError').textContent = 'Add the timestamp shown by the source. If you only want to explore the UI, use the demo example.'; $('formError').style.color = '#a14636'; $('readingTime').focus(); return; }
    renderPlan(value, source, timestamp);
  });
  $('tryExample').addEventListener('click', () => {
    aqInput.value = '168'; $('source').value = 'Illustrative sample'; $('readingTime').value = '';
    renderPlan(168, 'Illustrative sample', '', true);
  });
  ['location', 'activity'].forEach((id) => $(id).addEventListener('change', () => {
    if (!latestPlan || $('resultContent').hidden) return;
    const raw = aqInput.value.trim();
    if (raw === '' || !Number.isInteger(Number(raw)) || Number(raw) < 0 || Number(raw) > 500) return;
    renderPlan(Number(raw), renderedAsDemo ? 'Illustrative sample' : $('source').value, $('readingTime').value, false);
  }));
  $('source').addEventListener('change', () => {
    if (!$('resultContent') || $('resultContent').hidden) return;
    const raw = aqInput.value.trim();
    const value = raw !== '' && Number.isInteger(Number(raw)) && Number(raw) >= 0 && Number(raw) <= 500 ? Number(raw) : null;
    if (value === null || !$('source').value) return;
    renderPlan(value, $('source').value, $('readingTime').value, false);
  });

  // Plan management: copying, exporting, and saving on this browser only.
  function storageRead(key, fallback) {
    try { const value = JSON.parse(localStorage.getItem(key) || 'null'); return value ?? fallback; }
    catch (_) { return fallback; }
  }
  function storageWrite(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch (_) { return false; }
  }
  function downloadFile(filename, content, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob); const link = document.createElement('a');
    link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove(); URL.revokeObjectURL(url);
  }
  async function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    const textarea = document.createElement('textarea'); textarea.value = text; textarea.style.position = 'fixed'; textarea.style.opacity = '0'; document.body.append(textarea); textarea.select();
    const ok = document.execCommand('copy'); textarea.remove(); if (!ok) throw new Error('Copy is unavailable in this browser');
  }
  $('copyPlan').addEventListener('click', async () => {
    if (!latestPlan) { $('planToolsStatus').textContent = 'Generate a plan first.'; return; }
    try { await copyText(buildPlanText(latestPlan)); $('planToolsStatus').textContent = 'Plan copied. You can paste it into your notes or demo.'; }
    catch (_) { $('planToolsStatus').textContent = 'Copy was blocked by the browser. Use Download .txt instead.'; }
  });
  $('downloadPlan').addEventListener('click', () => {
    if (!latestPlan) { $('planToolsStatus').textContent = 'Generate a plan first.'; return; }
    downloadFile('airaware-campus-plan.txt', buildPlanText(latestPlan), 'text/plain;charset=utf-8'); $('planToolsStatus').textContent = 'Plan downloaded as a text file.';
  });
  function readHistory() { return storageRead(historyKey, []); }
  function renderHistory() {
    const list = $('historyList'); list.replaceChildren();
    const history = readHistory();
    if (!history.length) { const p = document.createElement('p'); p.className = 'history-empty'; p.textContent = 'No saved plans yet. Generate a plan, then choose “Save plan”.'; list.append(p); return; }
    history.forEach((plan, index) => {
      const card = document.createElement('article'); card.className = 'history-card';
      const copy = document.createElement('div'); const h = document.createElement('h3'); h.textContent = `${plan.location} · ${plan.category}`;
      const p1 = document.createElement('p'); p1.textContent = `${activityNames[plan.activity] || plan.activity} · source: ${plan.source}`;
      const p2 = document.createElement('p'); p2.textContent = `Reading time: ${displayTime(plan.readingTime)} · saved ${displayTime(plan.savedAt)}`;
      const button = document.createElement('button'); button.type = 'button'; button.className = 'text-button'; button.textContent = 'Load this plan'; button.addEventListener('click', () => {
        $('location').value = plan.location; $('activity').value = plan.activity; $('aqiInput').value = String(plan.aqi); $('source').value = plan.source; $('readingTime').value = plan.readingTime || '';
        renderPlan(Number(plan.aqi), plan.source, plan.readingTime || '', true); $('historyStatus').textContent = 'Saved plan loaded. Verify its reading before using it.'; window.scrollTo({ top: $('resultContent').getBoundingClientRect().top + window.scrollY - 24, behavior: 'smooth' });
      });
      copy.append(h, p1, p2, button); const value = document.createElement('div'); value.className = 'history-value'; value.textContent = String(plan.aqi); card.append(copy, value); list.append(card);
    });
  }
  $('savePlan').addEventListener('click', () => {
    if (!latestPlan) { $('planToolsStatus').textContent = 'Generate a plan first.'; return; }
    const history = readHistory(); history.unshift({ ...latestPlan, savedAt: new Date().toISOString() });
    if (!storageWrite(historyKey, history.slice(0, 10))) { $('planToolsStatus').textContent = 'Browser storage is unavailable. Download the plan instead.'; return; }
    renderHistory(); $('planToolsStatus').textContent = 'Plan saved in this browser only.';
  });
  $('clearHistory').addEventListener('click', () => {
    if (!confirm('Delete all AirAware plans saved in this browser?')) return;
    try { localStorage.removeItem(historyKey); } catch (_) {}
    renderHistory(); $('historyStatus').textContent = 'Local history cleared.';
  });
  $('exportHistory').addEventListener('click', () => {
    const history = readHistory();
    if (!history.length) { $('historyStatus').textContent = 'There are no saved plans to export.'; return; }
    downloadFile('airaware-saved-plans.json', JSON.stringify(history, null, 2), 'application/json;charset=utf-8'); $('historyStatus').textContent = 'Saved plans exported as JSON.';
  });
  renderHistory();

  // Persist checklist locally; no information is sent anywhere.
  const checks = Array.from(document.querySelectorAll('#checklist input[type="checkbox"]'));
  const savedChecks = storageRead(checklistKey, []);
  checks.forEach((checkbox, index) => { checkbox.checked = Boolean(savedChecks[index]); });
  function updateProgress() {
    const count = checks.filter((item) => item.checked).length;
    $('progressCount').textContent = `${count}/4`; $('progressBar').style.width = `${count / checks.length * 100}%`;
    $('progressRing').setAttribute('aria-label', `${count} of 4 checklist items complete`);
    $('checklistStatus').textContent = count === 0 ? 'Ready when your team is.' : count === checks.length ? 'All items reviewed.' : `${count} of 4 items reviewed.`;
    storageWrite(checklistKey, checks.map((item) => item.checked));
  }
  checks.forEach((checkbox) => checkbox.addEventListener('change', updateProgress));
  $('resetChecklist').addEventListener('click', () => { checks.forEach((checkbox) => { checkbox.checked = false; }); updateProgress(); });
  updateProgress();

  // Live data: WAQI station index via same-origin backend when configured;
  // otherwise fall back to clearly labelled Open-Meteo model estimates.
  const liveStatus = $('liveAirStatus');
  const LIVE_REFRESH_MS = 15 * 60 * 1000;
  function fmtMetric(value) { return value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? '—' : String(Math.round(Number(value) * 10) / 10); }
  function setSourceLink(url, label) {
    const link = $('liveSourceLink');
    link.href = url || 'https://open-meteo.com/en/docs/air-quality-api';
    link.textContent = label || 'Data source & method ↗';
  }
  function renderLiveAir(data) {
    const stationMode = data.mode === 'station';
    const current = data.current || {};
    const pollutants = data.pollutants || {};
    const indexValue = stationMode ? data.index : (data.index ?? current.us_aqi);
    $('liveIndexLabel').textContent = stationMode ? 'Station-reported AQI' : 'U.S. AQI (model estimate)';
    $('liveIndexValue').textContent = fmtMetric(indexValue);
    $('liveIndexScale').textContent = stationMode ? 'WAQI provider scale · not CPCB' : 'U.S. scale · not Indian CPCB';
    $('livePm25').textContent = fmtMetric(stationMode ? pollutants.pm25 : current.pm2_5);
    $('livePm10').textContent = fmtMetric(stationMode ? pollutants.pm10 : current.pm10);
    $('liveOtherLabel').textContent = stationMode ? 'Dominant pollutant' : 'European AQI (model)';
    $('liveOtherValue').textContent = stationMode ? String(data.dominant_pollutant || '—').toUpperCase() : fmtMetric(current.european_aqi);
    $('liveOtherUnit').textContent = stationMode ? 'As reported by provider' : 'European scale · not CPCB';
    $('liveSourceBadge').textContent = stationMode ? 'STATION FEED' : 'MODEL ESTIMATE';
    $('liveSourceBadge').classList.toggle('station-badge', stationMode);
    $('liveSourceBadge').classList.toggle('live-badge', !stationMode);
    const timestamp = stationMode ? (data.timestamp || 'timestamp not reported') : (current.time || 'model time not reported');
    const station = stationMode ? `Station: ${data.station || data.requested_location}. ` : `Model grid point: ${fmtMetric(data.latitude)}, ${fmtMetric(data.longitude)}. `;
    $('liveAirTimestamp').textContent = `${station}Source time: ${timestamp}${stationMode ? '' : ` (${data.timezone || 'Asia/Kolkata'})`}. Checked: ${data.checked_at || 'in this browser'}.`;
    const attributions = (data.attributions || []).map(item => item && item.name).filter(Boolean);
    $('liveAirAttribution').textContent = stationMode
      ? `Data via World Air Quality Index (WAQI). ${attributions.length ? `Provider attribution: ${attributions.join('; ')}.` : 'Provider-origin attribution may be supplied by the station feed.'} Follow the provider terms; station readings can be revised.`
      : 'Data via Open-Meteo Air Quality API using CAMS model data. This is a grid estimate and may differ from roadside or station measurements.';
    setSourceLink(stationMode ? (data.station_url || 'https://waqi.info/') : 'https://open-meteo.com/en/docs/air-quality-api', stationMode ? 'WAQI station & methodology ↗' : 'Open-Meteo source & method ↗');
    liveStatus.textContent = data.notice || (stationMode
      ? `A provider-reported station index loaded for ${data.requested_location}. It is not Indian CPCB NAQI.`
      : `Modelled air-quality context loaded for ${data.requested_location || $('location').value}. This is an estimate, not a local station reading.`);
    liveStatus.classList.toggle('error-text', Boolean(data.station_feed_error));
    $('liveSourceBadge').classList.remove('source-error');
    hasLiveData = true;
  }
  function openMeteoUrl(location) {
    const point = cities[location];
    if (!point) throw new Error('Live model context is available in this demo for Delhi, Noida and Gurugram only.');
    const query = new URLSearchParams({ latitude: String(point.latitude), longitude: String(point.longitude), current: 'pm10,pm2_5,us_aqi,european_aqi', timezone: 'Asia/Kolkata', forecast_days: '1' });
    return `https://air-quality-api.open-meteo.com/v1/air-quality?${query.toString()}`;
  }
  async function getJsonWithTimeout(url, timeoutMs = 12000) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { headers: { 'Accept': 'application/json' }, signal: controller.signal });
      const contentType = response.headers.get('content-type') || '';
      if (!response.ok || !contentType.toLowerCase().includes('application/json')) throw new Error(`Data endpoint returned HTTP ${response.status || 'error'}.`);
      return await response.json();
    } finally { window.clearTimeout(timeout); }
  }
  async function fetchLiveAir({ silent = false } = {}) {
    const location = $('location').value; const button = $('refreshLiveAir');
    if (!cities[location]) {
      liveStatus.textContent = 'Live feed is currently configured for Delhi, Noida and Gurugram. Choose one of those locations.';
      return;
    }
    button.disabled = true;
    if (!silent) { button.innerHTML = '<span>Refreshing…</span><span aria-hidden="true">↻</span>'; liveStatus.textContent = `Checking current air-quality information for ${location}…`; }
    try {
      let data = null;
      // Full-stack mode: the backend safely stores WAQI_API_TOKEN on the server.
      // Static mode: that route is unavailable, so the client can only use Open-Meteo.
      if (window.location.protocol !== 'file:') {
        try { data = await getJsonWithTimeout(`/api/live-aqi?location=${encodeURIComponent(location)}`); }
        catch (_) { data = null; }
      }
      if (!data) {
        const model = await getJsonWithTimeout(openMeteoUrl(location));
        data = { ...model, mode: 'model_estimate', source_type: 'model', provider: 'Open-Meteo Air Quality API (CAMS model data)', requested_location: location, source_url: 'https://open-meteo.com/en/docs/air-quality-api', checked_at: new Date().toISOString(), index: model.current?.us_aqi, index_label: 'U.S. AQI (model estimate)', index_scale: 'U.S. scale — not Indian CPCB NAQI', notice: 'Backend station feed is not available in this view. Showing an Open-Meteo model estimate, not a monitoring-station reading.' };
      }
      if (data.mode !== 'station' && !data.current) throw new Error('The provider did not return a usable current reading.');
      renderLiveAir(data);
    } catch (error) {
      const detail = error.name === 'AbortError' ? 'The request timed out.' : (error.message || 'Could not fetch the latest data.');
      liveStatus.textContent = `${detail} No new provider reading was loaded. ${hasLiveData ? 'Any displayed values are from the previous successful response and may be stale. ' : 'No current provider values are available in this view. '}Check your connection and retry. For India-specific National AQI, use the official CPCB portal.`;
      liveStatus.classList.add('error-text');
      $('liveSourceBadge').textContent = hasLiveData ? 'REFRESH FAILED' : 'SOURCE UNAVAILABLE';
      $('liveSourceBadge').classList.add('source-error');
    } finally {
      button.disabled = false;
      if (!silent) button.innerHTML = '<span>Refresh now</span><span aria-hidden="true">↻</span>';
    }
  }
  $('refreshLiveAir').addEventListener('click', () => fetchLiveAir());
  $('location').addEventListener('change', () => fetchLiveAir());
  // Poll every 15 minutes while the page is visible. The provider timestamp—not
  // the polling time—shows when its station/model data was produced.
  window.setInterval(() => { if (document.visibilityState === 'visible') fetchLiveAir({ silent: true }); }, LIVE_REFRESH_MS);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') fetchLiveAir({ silent: true }); });
  // Start with a clearly labelled example so the plan is visible as soon as the demo opens.
  // This is illustrative data, not a current measurement.
  if ($('aqiInput') && $('source') && $('resultContent') && $('resultContent').hidden) {
    $('aqiInput').value = '168';
    $('source').value = 'Illustrative sample';
    $('readingTime').value = '';
    renderPlan(168, 'Illustrative sample', '', true);
  }

  fetchLiveAir();

  // Optional Strands assistant. If backend/model is unavailable, be explicit and use local rule text.
  const assistantForm = $('assistantForm');
  const assistantStatus = $('assistantStatus'); const assistantResponse = $('assistantResponse'); const assistantAnswer = $('assistantAnswer');
  const assistantMode = $('assistantMode'); const assistantModeBadge = $('assistantModeBadge');
  async function checkAssistantBackend() {
    if (window.location.protocol === 'file:') {
      assistantMode.textContent = 'Local demo mode';
      assistantStatus.textContent = 'The planner and local rules work from this file. For a real Strands response, start the Python backend and verify Bedrock access.';
      return;
    }
    try {
      const response = await fetch('/api/health', { headers: { 'Accept': 'application/json' } });
      if (!response.ok) throw new Error('health check failed');
      const data = await response.json();
      assistantMode.textContent = data.strands_sdk_imported ? 'Backend ready · model checked on request' : 'Backend ready · Strands missing';
      assistantStatus.textContent = 'Backend is reachable. This health check does not prove model access; ask a question to test Bedrock.';
    } catch (_) {
      assistantMode.textContent = 'Local demo mode';
      assistantStatus.textContent = 'No same-origin Python backend detected. Questions use a clear rules-based fallback; they are not answered by an AI model.';
    }
  }
  function localAssistantAnswer(question) {
    const raw = aqInput.value.trim();
    if (raw === '' || !Number.isInteger(Number(raw)) || Number(raw) < 0 || Number(raw) > 500) {
      return 'No Indian AQI reading is currently entered. Check the CPCB portal, note the reading time, and enter the verified value before generating an activity plan. The live context card shows modelled PM concentrations and international indices, not Indian CPCB AQI. This response used local rules, not an AI model.';
    }
    const aqi = Number(raw), info = categoryInfo(aqi), activity = $('activity').value;
    const recommendations = adviceFor(activity, aqi).map(r => `• ${r[1]}: ${r[2]}`).join('\n');
    return `Rules-based explanation for ${$('location').value}: AQI ${aqi} is in the Indian CPCB ${info.name} band. Activity: ${activityNames[activity]}.\n${info.message}\n${recommendations}\n\nYour question: ${question}\nThis fallback uses local rules only; no AI model was called. Verify source, timestamp and official guidance.`;
  }
  checkAssistantBackend();
  assistantForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const question = $('assistantQuestion').value.trim() || 'What precautions should the campus consider?';
    const raw = aqInput.value.trim();
    const aqi = raw !== '' && Number.isInteger(Number(raw)) && Number(raw) >= 0 && Number(raw) <= 500 ? Number(raw) : null;
    const payload = { question, location: $('location').value, aqi, source: $('source').value || 'Not selected', activity: $('activity').value, mode: $('agentPattern').value };
    const submit = assistantForm.querySelector('button[type="submit"]'); submit.disabled = true; assistantStatus.textContent = 'Checking whether the Strands backend is available…';
    try {
      if (window.location.protocol === 'file:') throw new Error('Standalone mode');
      const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 55000);
      let response;
      try { response = await fetch('/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify(payload), signal: controller.signal }); }
      finally { clearTimeout(timeout); }
      if (!response.ok) throw new Error('The backend route is unavailable.');
      const data = await response.json();
      assistantAnswer.textContent = data.answer || 'No response was returned.';
      assistantModeBadge.textContent = data.mode || 'Unknown mode'; assistantModeBadge.classList.toggle('ai-on', Boolean(data.ai_used)); assistantModeBadge.classList.toggle('fallback', !data.ai_used); assistantResponse.hidden = false;
      assistantStatus.textContent = data.ai_used ? (data.agent_pattern === 'swarm' ? 'Multi-agent response returned. Check the response before presenting it.' : 'Strands single-agent response returned.') : 'Rules-based fallback returned. The AI model was not successfully called.';
    } catch (_) {
      assistantAnswer.textContent = localAssistantAnswer(question); assistantModeBadge.textContent = 'Local rules fallback · no AI call'; assistantModeBadge.classList.remove('ai-on'); assistantModeBadge.classList.add('fallback'); assistantResponse.hidden = false;
      assistantStatus.textContent = 'Backend/model not available in this view. Showing a rules-based explanation, not an AI response.';
    } finally { submit.disabled = false; }
  });
})();
