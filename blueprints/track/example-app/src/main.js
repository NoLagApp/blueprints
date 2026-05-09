import { NoLagTrack } from '@nolag/track';

// --- State ---
let tracker = null;
let activeZone = null;
let assetLocations = {}; // assetId -> latest location update
let onlineAssets = [];
let geofences = {}; // id -> geofence config
let geofenceAlerts = [];
let logEntries = [];

// London-area bounding box for random GPS
const LONDON = { minLat: 51.45, maxLat: 51.55, minLng: -0.20, maxLng: 0.02 };

function randomLondon() {
  return {
    lat: LONDON.minLat + Math.random() * (LONDON.maxLat - LONDON.minLat),
    lng: LONDON.minLng + Math.random() * (LONDON.maxLng - LONDON.minLng),
    speed: parseFloat((Math.random() * 80).toFixed(1)),
    heading: parseFloat((Math.random() * 360).toFixed(1)),
  };
}

// --- Render ---
function render() {
  document.getElementById('app').innerHTML = tracker && tracker.connected ? renderMain() : renderConnect();
  attachListeners();
}

function renderConnect() {
  return `
    <div class="flex items-center justify-center min-h-screen bg-base-100">
      <div class="card bg-base-200 shadow-xl w-full max-w-md">
        <div class="card-body gap-4">
          <h2 class="card-title text-2xl">@nolag/track SDK Demo</h2>
          <p class="text-base-content/60 text-sm">Vehicle/asset GPS tracking with real-time locations and geofencing.</p>
          <div class="form-control gap-1">
            <label class="label"><span class="label-text">Token</span></label>
            <input id="inp-token" type="text" placeholder="Your NoLag token" class="input input-bordered w-full" />
          </div>
          <div class="form-control gap-1">
            <label class="label"><span class="label-text">Asset Name</span></label>
            <input id="inp-assetname" type="text" placeholder="e.g. truck-01" value="truck-01" class="input input-bordered w-full" />
          </div>
          <div class="form-control gap-1">
            <label class="label"><span class="label-text">App Slug</span></label>
            <input id="inp-appname" type="text" placeholder="e.g. track-demo" value="track-demo" class="input input-bordered w-full" />
          </div>
          <div id="connect-error" class="text-error text-sm hidden"></div>
          <button id="btn-connect" class="btn btn-primary w-full">Connect</button>
        </div>
      </div>
    </div>`;
}

function renderMain() {
  const localAsset = tracker.localAsset;
  const zones = [...tracker.zones.values()];

  return `
    <div class="flex flex-col h-screen bg-base-100">
      <!-- Topbar -->
      <div class="flex items-center justify-between px-4 py-2 bg-base-200 border-b border-base-300">
        <span class="font-bold text-lg">@nolag/track Demo</span>
        <div class="flex items-center gap-3">
          ${localAsset ? `<span class="text-xs text-base-content/60">Asset: <span class="text-primary font-mono">${localAsset.assetName || localAsset.id}</span></span>` : ''}
          <span class="badge badge-success gap-1"><span class="w-2 h-2 rounded-full bg-success-content inline-block"></span>Connected</span>
          <button id="btn-disconnect" class="btn btn-sm btn-ghost text-error">Disconnect</button>
        </div>
      </div>

      <!-- Body -->
      <div class="flex flex-1 overflow-hidden">
        <!-- Left sidebar -->
        <div class="w-56 flex-shrink-0 bg-base-200 border-r border-base-300 flex flex-col p-3 gap-4 overflow-y-auto">
          <div>
            <div class="text-xs font-bold text-base-content/50 uppercase mb-2">Zones</div>
            ${zones.length === 0
              ? '<div class="text-xs text-base-content/40">No zones joined</div>'
              : zones.map(z => `
                <div class="flex items-center justify-between mb-1">
                  <button class="btn btn-xs btn-ghost text-left flex-1 ${activeZone && activeZone.name === z.name ? 'btn-active' : ''}" data-zone="${z.name}">${z.name}</button>
                  <button class="btn btn-xs btn-ghost text-error" data-leave-zone="${z.name}">x</button>
                </div>`).join('')
            }
            <div class="flex gap-1 mt-2">
              <input id="inp-join-zone" type="text" placeholder="zone name" class="input input-xs input-bordered flex-1" value="fleet-zone" />
              <button id="btn-join-zone" class="btn btn-xs btn-primary">Join</button>
            </div>
          </div>

          <div>
            <div class="text-xs font-bold text-base-content/50 uppercase mb-2">Online Assets</div>
            ${onlineAssets.length === 0
              ? '<div class="text-xs text-base-content/40">None</div>'
              : onlineAssets.map(a => `
                <div class="text-xs py-0.5 flex items-center gap-1">
                  <span class="w-1.5 h-1.5 rounded-full bg-success inline-block"></span>
                  <span class="font-mono">${a.assetName || a.id}</span>
                </div>`).join('')
            }
            <button id="btn-get-online" class="btn btn-xs btn-ghost mt-1 w-full">Refresh</button>
          </div>

          <div>
            <div class="text-xs font-bold text-base-content/50 uppercase mb-2">Zone Assets</div>
            ${activeZone
              ? `<button id="btn-get-zone-assets" class="btn btn-xs btn-ghost w-full">Fetch Assets</button>`
              : '<div class="text-xs text-base-content/40">Join a zone first</div>'
            }
          </div>
        </div>

        <!-- Center -->
        <div class="flex-1 overflow-y-auto p-4 flex flex-col gap-4">

          <!-- Send location -->
          <div class="card bg-base-200">
            <div class="card-body p-3">
              <div class="flex items-center justify-between">
                <h3 class="font-bold text-sm">Send Location</h3>
                <div class="flex gap-2">
                  <button id="btn-send-random" class="btn btn-sm btn-primary" ${!activeZone ? 'disabled' : ''}>Send Random (London)</button>
                  <button id="btn-send-custom" class="btn btn-sm btn-ghost" ${!activeZone ? 'disabled' : ''}>Send Custom</button>
                </div>
              </div>
              <div id="custom-loc-form" class="hidden flex flex-wrap gap-2 mt-2">
                <input id="inp-lat" type="number" step="0.0001" placeholder="Lat" value="51.5074" class="input input-bordered input-sm w-28" />
                <input id="inp-lng" type="number" step="0.0001" placeholder="Lng" value="-0.1278" class="input input-bordered input-sm w-28" />
                <input id="inp-speed" type="number" step="0.1" placeholder="Speed" value="30" class="input input-bordered input-sm w-20" />
                <input id="inp-heading" type="number" step="1" min="0" max="360" placeholder="Heading" value="90" class="input input-bordered input-sm w-24" />
                <button id="btn-send-custom-submit" class="btn btn-sm btn-primary" ${!activeZone ? 'disabled' : ''}>Send</button>
              </div>
            </div>
          </div>

          <!-- Asset tracking table -->
          <div class="card bg-base-200">
            <div class="card-body p-3">
              <div class="flex items-center justify-between mb-2">
                <h3 class="font-bold text-sm">Asset Locations</h3>
                <button id="btn-get-history" class="btn btn-xs btn-ghost" ${!activeZone ? 'disabled' : ''}>Fetch History (local)</button>
              </div>
              <div class="overflow-x-auto">
                <table class="table table-xs w-full">
                  <thead><tr><th>Asset ID</th><th>Lat</th><th>Lng</th><th>Speed</th><th>Heading</th><th>Timestamp</th></tr></thead>
                  <tbody>
                    ${Object.keys(assetLocations).length === 0
                      ? `<tr><td colspan="6" class="text-center text-base-content/40 py-4">No location data yet</td></tr>`
                      : Object.entries(assetLocations).map(([assetId, loc]) => `
                        <tr class="fade-in">
                          <td class="font-mono text-primary">${assetId}</td>
                          <td>${loc.lat?.toFixed(5) ?? '--'}</td>
                          <td>${loc.lng?.toFixed(5) ?? '--'}</td>
                          <td>${loc.speed != null ? loc.speed + ' km/h' : '--'}</td>
                          <td>${loc.heading != null ? loc.heading + '°' : '--'}</td>
                          <td class="text-base-content/50">${loc.timestamp ? new Date(loc.timestamp).toTimeString().slice(0,8) : '--'}</td>
                        </tr>`).join('')
                    }
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <!-- Geofence management -->
          <div class="card bg-base-200">
            <div class="card-body p-3">
              <h3 class="font-bold text-sm mb-3">Geofence Management</h3>
              <!-- Add geofence form -->
              <div class="bg-base-300 rounded p-3 mb-3">
                <div class="text-xs font-bold text-base-content/50 uppercase mb-2">Add Circle Geofence</div>
                <div class="flex flex-wrap gap-2 items-end">
                  <div class="form-control gap-1">
                    <label class="label py-0"><span class="label-text text-xs">ID</span></label>
                    <input id="inp-gf-id" type="text" placeholder="fence-1" value="fence-1" class="input input-bordered input-sm w-24" />
                  </div>
                  <div class="form-control gap-1">
                    <label class="label py-0"><span class="label-text text-xs">Name</span></label>
                    <input id="inp-gf-name" type="text" placeholder="Zone A" value="Zone A" class="input input-bordered input-sm w-28" />
                  </div>
                  <div class="form-control gap-1">
                    <label class="label py-0"><span class="label-text text-xs">Center Lat</span></label>
                    <input id="inp-gf-lat" type="number" step="0.0001" value="51.5074" class="input input-bordered input-sm w-28" />
                  </div>
                  <div class="form-control gap-1">
                    <label class="label py-0"><span class="label-text text-xs">Center Lng</span></label>
                    <input id="inp-gf-lng" type="number" step="0.0001" value="-0.1278" class="input input-bordered input-sm w-28" />
                  </div>
                  <div class="form-control gap-1">
                    <label class="label py-0"><span class="label-text text-xs">Radius (m)</span></label>
                    <input id="inp-gf-radius" type="number" step="100" value="500" class="input input-bordered input-sm w-24" />
                  </div>
                  <button id="btn-add-geofence" class="btn btn-sm btn-primary" ${!activeZone ? 'disabled' : ''}>Add Geofence</button>
                </div>
              </div>

              <!-- Active geofences -->
              <div class="mb-3">
                <div class="flex items-center justify-between mb-2">
                  <div class="text-xs font-bold text-base-content/50 uppercase">Active Geofences</div>
                  <button id="btn-get-geofences" class="btn btn-xs btn-ghost" ${!activeZone ? 'disabled' : ''}>Fetch</button>
                </div>
                ${Object.keys(geofences).length === 0
                  ? '<div class="text-xs text-base-content/40">No geofences defined</div>'
                  : `<div class="flex flex-wrap gap-2">
                      ${Object.entries(geofences).map(([id, gf]) => `
                        <div class="flex items-center gap-2 bg-base-300 rounded px-2 py-1">
                          <span class="text-xs font-mono text-primary">${id}</span>
                          <span class="text-xs text-base-content/60">${gf.name || ''}</span>
                          <span class="text-xs text-base-content/40">${gf.radiusMeters}m</span>
                          <button class="btn btn-xs btn-ghost text-error" data-remove-gf="${id}">x</button>
                        </div>`).join('')}
                    </div>`
                }
              </div>

              <!-- Geofence alerts -->
              <div>
                <div class="text-xs font-bold text-base-content/50 uppercase mb-2">Geofence Alerts</div>
                <div class="flex flex-col gap-0.5 max-h-36 overflow-y-auto">
                  ${geofenceAlerts.length === 0
                    ? '<div class="text-xs text-base-content/40">No alerts yet</div>'
                    : geofenceAlerts.slice(-20).reverse().map(a => `
                      <div class="flex items-center gap-2 text-xs font-mono py-0.5 px-2 rounded fade-in ${a.type === 'enter' ? 'bg-success/10 text-success' : 'bg-error/10 text-error'}">
                        <span class="font-bold">${a.type === 'enter' ? 'ENTER' : 'EXIT'}</span>
                        <span>fence: ${a.geofenceId}</span>
                        <span>asset: ${a.assetId}</span>
                        <span class="text-base-content/40">${a.time}</span>
                      </div>`).join('')
                  }
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Right sidebar: event log -->
        <div class="w-64 flex-shrink-0 bg-base-200 border-l border-base-300 flex flex-col">
          <div class="flex items-center justify-between px-3 py-2 border-b border-base-300">
            <span class="text-xs font-bold text-base-content/50 uppercase">Event Log</span>
            <button id="btn-clear-log" class="btn btn-xs btn-ghost">Clear</button>
          </div>
          <div id="log-container" class="flex-1 overflow-y-auto py-1">
            ${logEntries.slice(-100).reverse().map(e =>
              `<div class="log-entry ${e.type} fade-in"><span class="text-base-content/40">${e.time}</span> ${e.msg}</div>`
            ).join('')}
          </div>
        </div>
      </div>
    </div>`;
}

// --- Listeners ---
function attachListeners() {
  if (!tracker || !tracker.connected) {
    document.getElementById('btn-connect')?.addEventListener('click', handleConnect);
    document.getElementById('inp-token')?.addEventListener('keydown', e => e.key === 'Enter' && handleConnect());
    return;
  }

  document.getElementById('btn-disconnect')?.addEventListener('click', handleDisconnect);
  document.getElementById('btn-join-zone')?.addEventListener('click', handleJoinZone);
  document.getElementById('inp-join-zone')?.addEventListener('keydown', e => e.key === 'Enter' && handleJoinZone());
  document.getElementById('btn-send-random')?.addEventListener('click', handleSendRandom);
  document.getElementById('btn-send-custom')?.addEventListener('click', () => {
    const form = document.getElementById('custom-loc-form');
    form?.classList.toggle('hidden');
  });
  document.getElementById('btn-send-custom-submit')?.addEventListener('click', handleSendCustom);
  document.getElementById('btn-add-geofence')?.addEventListener('click', handleAddGeofence);
  document.getElementById('btn-get-geofences')?.addEventListener('click', handleGetGeofences);
  document.getElementById('btn-get-online')?.addEventListener('click', handleGetOnlineAssets);
  document.getElementById('btn-get-zone-assets')?.addEventListener('click', handleGetZoneAssets);
  document.getElementById('btn-get-history')?.addEventListener('click', handleGetHistory);
  document.getElementById('btn-clear-log')?.addEventListener('click', () => { logEntries = []; render(); });

  document.querySelectorAll('[data-zone]').forEach(btn => {
    btn.addEventListener('click', () => {
      const z = ([...tracker.zones.values()]).find(x => x.name === btn.dataset.zone);
      if (z) { activeZone = z; render(); }
    });
  });

  document.querySelectorAll('[data-leave-zone]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const name = btn.dataset.leaveZone;
      addLog('action', `Leaving zone: ${name}`);
      await tracker.leaveZone(name);
      if (activeZone && activeZone.name === name) activeZone = null;
      render();
    });
  });

  document.querySelectorAll('[data-remove-gf]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.removeGf;
      if (!activeZone) return;
      try {
        await activeZone.removeGeofence(id);
        delete geofences[id];
        addLog('action', `removeGeofence: ${id}`);
      } catch (err) {
        addLog('error', `removeGeofence failed: ${err.message}`);
      }
      render();
    });
  });
}

// --- Handlers ---
async function handleConnect() {
  const token = document.getElementById('inp-token').value.trim();
  const assetName = document.getElementById('inp-assetname').value.trim() || 'truck-01';
  const appName = document.getElementById('inp-appname').value.trim() || 'track-demo';
  const errEl = document.getElementById('connect-error');

  if (!token) {
    errEl.textContent = 'Token is required.';
    errEl.classList.remove('hidden');
    return;
  }
  errEl.classList.add('hidden');

  const btn = document.getElementById('btn-connect');
  btn.disabled = true;
  btn.textContent = 'Connecting...';

  try {
    tracker = new NoLagTrack(token, {
      assetName,
      appName,
      debug: false,
      url: 'wss://broker.dev.nolag.app/ws',
    });

    tracker.on('connected', async () => {
      addLog('event', 'connected');
      // Auto-join fleet-zone
      await joinZone('fleet-zone');
      render();
    });

    tracker.on('disconnected', reason => {
      addLog('error', `disconnected: ${reason || ''}`);
      activeZone = null;
      render();
    });

    tracker.on('reconnected', () => {
      addLog('event', 'reconnected');
      render();
    });

    tracker.on('error', err => {
      addLog('error', `error: ${err?.message || err}`);
      render();
    });

    tracker.on('assetOnline', asset => {
      addLog('event', `assetOnline: ${asset.assetName || asset.id}`);
      onlineAssets = [...onlineAssets.filter(a => a.id !== asset.id), asset];
      render();
    });

    tracker.on('assetOffline', asset => {
      addLog('event', `assetOffline: ${asset.assetName || asset.id}`);
      onlineAssets = onlineAssets.filter(a => a.id !== asset.id);
      render();
    });

    await tracker.connect();
  } catch (err) {
    errEl.textContent = `Connection failed: ${err.message}`;
    errEl.classList.remove('hidden');
    btn.disabled = false;
    btn.textContent = 'Connect';
  }
}

async function joinZone(name) {
  addLog('action', `Joining zone: ${name}`);
  const zone = await tracker.joinZone(name);

  zone.on('locationUpdate', update => {
    assetLocations[update.assetId] = {
      lat: update.point.lat,
      lng: update.point.lng,
      speed: update.point.speed,
      heading: update.point.heading,
      timestamp: update.timestamp || Date.now(),
    };
    addLog('event', `locationUpdate [${update.assetId}] lat=${update.point.lat?.toFixed(4)} lng=${update.point.lng?.toFixed(4)} spd=${update.point.speed}`);
    render();
  });

  zone.on('assetJoined', asset => {
    addLog('event', `assetJoined zone [${name}]: ${asset.assetName || asset.id}`);
    onlineAssets = [...onlineAssets.filter(a => a.id !== asset.id), asset];
    render();
  });

  zone.on('assetLeft', asset => {
    addLog('event', `assetLeft zone [${name}]: ${asset.assetName || asset.id}`);
    onlineAssets = onlineAssets.filter(a => a.id !== asset.id);
    render();
  });

  zone.on('geofenceTriggered', event => {
    const alert = {
      type: event.type,
      geofenceId: event.geofenceId,
      assetId: event.assetId,
      time: new Date().toTimeString().slice(0, 8),
    };
    geofenceAlerts.push(alert);
    if (geofenceAlerts.length > 100) geofenceAlerts.shift();
    addLog(event.type === 'enter' ? 'event' : 'error',
      `geofenceTriggered: ${event.type.toUpperCase()} | fence=${event.geofenceId} asset=${event.assetId}`);
    render();
  });

  activeZone = zone;
  return zone;
}

async function handleJoinZone() {
  const name = document.getElementById('inp-join-zone')?.value.trim();
  if (!name || !tracker) return;
  try {
    await joinZone(name);
    render();
  } catch (err) {
    addLog('error', `joinZone failed: ${err.message}`);
    render();
  }
}

async function handleDisconnect() {
  addLog('action', 'Disconnecting...');
  await tracker.disconnect();
  tracker = null;
  activeZone = null;
  onlineAssets = [];
  assetLocations = {};
  render();
}

async function handleSendRandom() {
  if (!activeZone) return;
  const loc = randomLondon();
  try {
    await activeZone.sendLocation(loc);
    addLog('action', `sendLocation lat=${loc.lat.toFixed(4)} lng=${loc.lng.toFixed(4)} spd=${loc.speed}`);
  } catch (err) {
    addLog('error', `sendLocation failed: ${err.message}`);
  }
}

async function handleSendCustom() {
  if (!activeZone) return;
  const lat = parseFloat(document.getElementById('inp-lat').value);
  const lng = parseFloat(document.getElementById('inp-lng').value);
  const speed = parseFloat(document.getElementById('inp-speed').value);
  const heading = parseFloat(document.getElementById('inp-heading').value);
  try {
    await activeZone.sendLocation({ lat, lng, speed, heading });
    addLog('action', `sendLocation (custom) lat=${lat} lng=${lng} spd=${speed} hdg=${heading}`);
  } catch (err) {
    addLog('error', `sendLocation failed: ${err.message}`);
  }
}

async function handleAddGeofence() {
  if (!activeZone) return;
  const id = document.getElementById('inp-gf-id').value.trim() || 'fence-1';
  const name = document.getElementById('inp-gf-name').value.trim() || 'Zone A';
  const lat = parseFloat(document.getElementById('inp-gf-lat').value);
  const lng = parseFloat(document.getElementById('inp-gf-lng').value);
  const radiusMeters = parseFloat(document.getElementById('inp-gf-radius').value);
  const config = { id, shape: 'circle', center: { lat, lng }, radiusMeters, name };
  try {
    await activeZone.addGeofence(config);
    geofences[id] = config;
    addLog('action', `addGeofence [${id}] "${name}" r=${radiusMeters}m @(${lat.toFixed(4)},${lng.toFixed(4)})`);
  } catch (err) {
    addLog('error', `addGeofence failed: ${err.message}`);
  }
  render();
}

async function handleGetGeofences() {
  if (!activeZone) return;
  try {
    const all = await activeZone.getGeofences();
    addLog('action', `getGeofences: ${all?.length ?? 0} returned`);
    if (all) {
      for (const gf of all) {
        geofences[gf.id] = gf;
      }
    }
  } catch (err) {
    addLog('error', `getGeofences failed: ${err.message}`);
  }
  render();
}

async function handleGetOnlineAssets() {
  if (!tracker) return;
  try {
    const all = await tracker.getOnlineAssets();
    addLog('action', `getOnlineAssets: ${all?.length ?? 0} online`);
    if (all) onlineAssets = all;
  } catch (err) {
    addLog('error', `getOnlineAssets failed: ${err.message}`);
  }
  render();
}

async function handleGetZoneAssets() {
  if (!activeZone) return;
  try {
    const all = await activeZone.getAssets();
    addLog('action', `getAssets (zone): ${all?.length ?? 0} assets`);
    if (all) {
      for (const a of all) {
        // Optionally inspect individual asset
        const detail = await activeZone.getAsset(a.id);
        addLog('event', `getAsset [${a.id}]: ${JSON.stringify(detail).slice(0, 80)}`);
      }
    }
  } catch (err) {
    addLog('error', `getAssets failed: ${err.message}`);
  }
  render();
}

async function handleGetHistory() {
  if (!activeZone) return;
  const localAsset = tracker.localAsset;
  if (!localAsset) {
    addLog('error', 'No local asset ID available for history fetch');
    return;
  }
  try {
    const history = await activeZone.getLocationHistory(localAsset.id);
    addLog('action', `getLocationHistory [${localAsset.id}]: ${history?.length ?? 0} points`);
  } catch (err) {
    addLog('error', `getLocationHistory failed: ${err.message}`);
  }
}

// --- Utils ---
function addLog(type, msg) {
  const now = new Date();
  const time = now.toTimeString().slice(0, 8);
  logEntries.push({ type, msg, time });
  if (logEntries.length > 200) logEntries.shift();
}

// --- Boot ---
render();