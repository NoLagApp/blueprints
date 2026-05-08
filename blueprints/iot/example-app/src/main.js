import { NoLagIoT } from '@nolag/iot';

// ── State ────────────────────────────────────────────────────────────────────
let iot = null;
let activeGroup = null;
let autoSendInterval = null;
let pendingCommands = []; // commands received when role === 'device'
let telemetryRows = [];   // readings received when role === 'controller'

const SENSORS = [
  { id: 'temperature', label: 'Temperature', unit: '°C', defaultVal: '22.5' },
  { id: 'humidity',    label: 'Humidity',    unit: '%',  defaultVal: '55' },
  { id: 'pressure',    label: 'Pressure',    unit: 'hPa', defaultVal: '1013' },
];

// ── Helpers ──────────────────────────────────────────────────────────────────
function ts() {
  return new Date().toLocaleTimeString();
}

function addLog(msg, type = 'event') {
  const log = document.getElementById('event-log');
  if (!log) return;
  const el = document.createElement('div');
  el.className = `log-entry ${type} fade-in`;
  el.textContent = `[${ts()}] ${msg}`;
  log.prepend(el);
  if (log.children.length > 120) log.lastChild.remove();
}

function setStatus(connected) {
  const dot = document.getElementById('status-dot');
  const label = document.getElementById('status-label');
  if (!dot || !label) return;
  dot.className = connected
    ? 'w-2.5 h-2.5 rounded-full bg-success'
    : 'w-2.5 h-2.5 rounded-full bg-error';
  label.textContent = connected ? 'Connected' : 'Disconnected';
}

function getRole() {
  return document.getElementById('role-select')?.value ?? 'device';
}

// ── Render helpers ───────────────────────────────────────────────────────────
function renderOnlineDevices() {
  const container = document.getElementById('online-devices');
  if (!container || !iot) return;
  const devices = iot.getOnlineDevices();
  container.innerHTML = devices.length === 0
    ? '<p class="text-xs opacity-50 px-2">No devices online</p>'
    : devices.map(d => `
        <div class="flex items-center gap-2 px-2 py-1 rounded hover:bg-base-300 text-sm">
          <span class="w-2 h-2 rounded-full bg-success"></span>
          <span class="flex-1 truncate">${d.deviceName ?? d.deviceId}</span>
          <span class="badge badge-xs ${ d.role === 'device' ? 'badge-primary' : 'badge-secondary' }">${d.role ?? '?'}</span>
        </div>`).join('');
}

function renderGroupDevices() {
  const container = document.getElementById('group-devices');
  if (!container || !activeGroup) return;
  const devices = activeGroup.getDevices();
  container.innerHTML = devices.length === 0
    ? '<p class="text-xs opacity-50 px-2">No devices in group</p>'
    : devices.map(d => `
        <div class="flex items-center gap-2 px-2 py-1 rounded text-sm">
          <span class="w-2 h-2 rounded-full bg-success"></span>
          <span class="flex-1 truncate">${d.deviceName ?? d.deviceId}</span>
          <span class="badge badge-xs ${ d.role === 'device' ? 'badge-primary' : 'badge-secondary' }">${d.role ?? '?'}</span>
        </div>`).join('');

  // also refresh target device select for controller command form
  const sel = document.getElementById('cmd-target-device');
  if (sel) {
    const current = sel.value;
    sel.innerHTML = '<option value="">— select device —</option>' +
      devices.filter(d => d.role === 'device').map(d =>
        `<option value="${d.deviceId}" ${d.deviceId === current ? 'selected' : ''}>${d.deviceName ?? d.deviceId}</option>`
      ).join('');
  }
}

function renderPendingCommands() {
  const container = document.getElementById('command-inbox');
  if (!container) return;
  if (pendingCommands.length === 0) {
    container.innerHTML = '<p class="text-xs opacity-50 text-center py-4">No pending commands</p>';
    return;
  }
  container.innerHTML = pendingCommands.map((cmd, i) => `
    <div class="bg-base-300 rounded p-3 space-y-1 text-sm fade-in" data-cmd-index="${i}">
      <div class="flex items-center justify-between">
        <span class="font-semibold text-primary">${cmd.command}</span>
        <span class="text-xs opacity-50">${ts()}</span>
      </div>
      ${cmd.params && Object.keys(cmd.params).length ? `<pre class="text-xs opacity-70 bg-base-200 rounded p-1 overflow-x-auto">${JSON.stringify(cmd.params, null, 2)}</pre>` : ''}
      <p class="text-xs opacity-60">From: ${cmd.fromDeviceId}</p>
      <div class="flex gap-2 pt-1">
        <button onclick="handleAck(${i}, 'acked')" class="btn btn-xs btn-secondary">Ack</button>
        <button onclick="handleAck(${i}, 'completed')" class="btn btn-xs btn-success">Complete</button>
        <button onclick="handleAck(${i}, 'failed')" class="btn btn-xs btn-error">Fail</button>
      </div>
    </div>`).join('');
}

function renderTelemetryTable() {
  const tbody = document.getElementById('telemetry-tbody');
  if (!tbody) return;
  if (telemetryRows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="text-center opacity-50 py-4 text-xs">Waiting for telemetry…</td></tr>';
    return;
  }
  tbody.innerHTML = telemetryRows.slice(-50).reverse().map(r => `
    <tr class="fade-in">
      <td class="font-mono text-xs">${r.deviceId.slice(0, 12)}…</td>
      <td>${r.sensorId}</td>
      <td class="text-primary font-semibold">${r.value}</td>
      <td class="opacity-70">${r.unit ?? ''}</td>
      <td class="text-xs opacity-50">${new Date(r.timestamp).toLocaleTimeString()}</td>
    </tr>`).join('');
}

// ── Global callbacks for inline onclick handlers ──────────────────────────────
window.handleAck = async function(index, status) {
  if (!activeGroup) return;
  const cmd = pendingCommands[index];
  if (!cmd) return;
  try {
    await activeGroup.ackCommand(cmd.id, status, { handledAt: Date.now() });
    addLog(`Acked command "${cmd.command}" → ${status}`, 'action');
    pendingCommands.splice(index, 1);
    renderPendingCommands();
  } catch (err) {
    addLog(`ackCommand error: ${err.message}`, 'error');
  }
};

window.leaveGroup = async function(name) {
  if (!iot) return;
  try {
    await iot.leaveGroup(name);
    activeGroup = null;
    addLog(`Left group "${name}"`, 'action');
    renderGroupDevices();
  } catch (err) {
    addLog(`leaveGroup error: ${err.message}`, 'error');
  }
};

// ── Connect / Disconnect ──────────────────────────────────────────────────────
async function connect() {
  const token      = document.getElementById('token-input').value.trim();
  const deviceName = document.getElementById('device-name-input').value.trim() || 'my-device';
  const role       = getRole();
  const appName    = document.getElementById('app-name-input').value.trim() || 'iot-demo';

  if (!token) { addLog('Token is required', 'error'); return; }

  if (iot) {
    await iot.disconnect();
    iot = null;
    activeGroup = null;
  }

  addLog(`Connecting as ${role} "${deviceName}"…`, 'action');

  iot = new NoLagIoT(token, {
    deviceName,
    role,
    appName,
    debug: false,
    groups: ['factory-floor'],
  });

  // ── Main events ──────────────────────────────────────────────────────────
  iot.on('connected', async () => {
    setStatus(true);
    addLog('Connected to NoLag IoT', 'event');
    renderOnlineDevices();
    showRoleUI(role);
    // Auto-join the factory-floor group
    await joinGroup('factory-floor');
  });

  iot.on('disconnected', reason => {
    setStatus(false);
    addLog(`Disconnected: ${reason ?? 'unknown'}`, 'error');
    stopAutoSend();
  });

  iot.on('reconnected', () => {
    setStatus(true);
    addLog('Reconnected', 'event');
  });

  iot.on('error', err => {
    addLog(`Error: ${err?.message ?? err}`, 'error');
  });

  iot.on('deviceOnline', device => {
    addLog(`Device online: ${device.deviceName ?? device.deviceId} (${device.role})`, 'event');
    renderOnlineDevices();
  });

  iot.on('deviceOffline', device => {
    addLog(`Device offline: ${device.deviceName ?? device.deviceId}`, 'event');
    renderOnlineDevices();
  });

  await iot.connect();
}

async function disconnect() {
  if (!iot) return;
  stopAutoSend();
  await iot.disconnect();
  iot = null;
  activeGroup = null;
  setStatus(false);
  addLog('Disconnected by user', 'action');
  renderOnlineDevices();
  renderGroupDevices();
}

// ── Group management ──────────────────────────────────────────────────────────
async function joinGroup(name) {
  if (!iot) return;
  try {
    const group = await iot.joinGroup(name);
    activeGroup = group;
    addLog(`Joined group "${group.name}"`, 'event');

    // ── Group events ────────────────────────────────────────────────────────
    group.on('telemetry', reading => {
      addLog(`Telemetry [${reading.sensorId}] ${reading.value}${reading.unit ?? ''} from ${reading.deviceId.slice(0,8)}`, 'event');
      telemetryRows.push(reading);
      renderTelemetryTable();
    });

    group.on('command', command => {
      addLog(`Command received: "${command.command}" (id:${command.id.slice(0,8)}) from ${command.fromDeviceId.slice(0,8)}`, 'event');
      pendingCommands.push(command);
      renderPendingCommands();
    });

    group.on('commandAck', ack => {
      addLog(`Command ack: id=${ack.id.slice(0,8)} status=${ack.status}`, 'event');
    });

    group.on('deviceJoined', device => {
      addLog(`Device joined group: ${device.deviceName ?? device.deviceId}`, 'event');
      renderGroupDevices();
    });

    group.on('deviceLeft', device => {
      addLog(`Device left group: ${device.deviceName ?? device.deviceId}`, 'event');
      renderGroupDevices();
    });

    renderGroupDevices();
    renderGroupList();
  } catch (err) {
    addLog(`joinGroup error: ${err.message}`, 'error');
  }
}

function renderGroupList() {
  const container = document.getElementById('group-list');
  if (!container || !iot) return;
  const groups = iot.getGroups();
  if (groups.length === 0) {
    container.innerHTML = '<p class="text-xs opacity-50 px-2">No groups joined</p>';
    return;
  }
  container.innerHTML = groups.map(g => `
    <div class="flex items-center gap-2 px-2 py-1 rounded bg-base-300 text-sm">
      <span class="flex-1 font-medium">${g.name}</span>
      <button onclick="leaveGroup('${g.name}')" class="btn btn-xs btn-ghost opacity-60 hover:opacity-100">Leave</button>
    </div>`).join('');
}

// ── Send Telemetry ────────────────────────────────────────────────────────────
async function sendTelemetry() {
  if (!activeGroup) { addLog('Not in a group', 'error'); return; }
  const sensorId = document.getElementById('sensor-select').value;
  const value    = parseFloat(document.getElementById('sensor-value').value);
  const unit     = document.getElementById('sensor-unit').value.trim();
  if (isNaN(value)) { addLog('Invalid sensor value', 'error'); return; }
  try {
    await activeGroup.sendTelemetry(sensorId, value, { unit });
    addLog(`Sent telemetry [${sensorId}] ${value}${unit}`, 'action');
  } catch (err) {
    addLog(`sendTelemetry error: ${err.message}`, 'error');
  }
}

function toggleAutoSend() {
  const btn = document.getElementById('auto-send-btn');
  if (autoSendInterval) {
    stopAutoSend();
    btn.textContent = 'Start Auto-Send';
    btn.classList.remove('btn-error');
    btn.classList.add('btn-secondary');
  } else {
    btn.textContent = 'Stop Auto-Send';
    btn.classList.remove('btn-secondary');
    btn.classList.add('btn-error');
    autoSendInterval = setInterval(() => {
      if (!activeGroup) return;
      const sensor = SENSORS[Math.floor(Math.random() * SENSORS.length)];
      const base   = parseFloat(sensor.defaultVal);
      const value  = +(base + (Math.random() - 0.5) * base * 0.05).toFixed(2);
      activeGroup.sendTelemetry(sensor.id, value, { unit: sensor.unit })
        .then(() => addLog(`Auto-sent [${sensor.id}] ${value}${sensor.unit}`, 'action'))
        .catch(err => addLog(`Auto-send error: ${err.message}`, 'error'));
    }, 2000);
  }
}

function stopAutoSend() {
  if (autoSendInterval) {
    clearInterval(autoSendInterval);
    autoSendInterval = null;
  }
}

// ── Send Command ──────────────────────────────────────────────────────────────
async function sendCommand() {
  if (!activeGroup) { addLog('Not in a group', 'error'); return; }
  const targetDeviceId = document.getElementById('cmd-target-device').value;
  const command        = document.getElementById('cmd-name').value.trim();
  const paramsRaw      = document.getElementById('cmd-params').value.trim();
  if (!targetDeviceId) { addLog('Select a target device', 'error'); return; }
  if (!command)        { addLog('Command name is required', 'error'); return; }
  let params = {};
  if (paramsRaw) {
    try { params = JSON.parse(paramsRaw); }
    catch { addLog('Invalid JSON in params', 'error'); return; }
  }
  try {
    const ack = await activeGroup.sendCommand(targetDeviceId, command, params);
    addLog(`Command "${command}" sent → ${targetDeviceId.slice(0,8)} (ack: ${JSON.stringify(ack)})`, 'action');
  } catch (err) {
    addLog(`sendCommand error: ${err.message}`, 'error');
  }
}

// ── Show/hide role-specific panels ───────────────────────────────────────────
function showRoleUI(role) {
  const devicePanel     = document.getElementById('device-panel');
  const controllerPanel = document.getElementById('controller-panel');
  if (devicePanel)     devicePanel.classList.toggle('hidden', role !== 'device');
  if (controllerPanel) controllerPanel.classList.toggle('hidden', role !== 'controller');
}

// ── Sensor select → auto-fill unit ───────────────────────────────────────────
function onSensorChange() {
  const sensorId = document.getElementById('sensor-select').value;
  const sensor   = SENSORS.find(s => s.id === sensorId);
  if (sensor) {
    document.getElementById('sensor-unit').value  = sensor.unit;
    document.getElementById('sensor-value').value = sensor.defaultVal;
  }
}

// ── Render app shell ──────────────────────────────────────────────────────────
function render() {
  document.getElementById('app').innerHTML = `
  <div class="flex flex-col h-screen bg-base-100 text-base-content">

    <!-- Top bar -->
    <header class="flex items-center gap-4 px-4 py-2 bg-base-200 border-b border-base-300 shrink-0">
      <span class="font-bold text-lg text-primary" style="font-family:'Ubuntu',sans-serif">NoLag IoT</span>
      <div class="flex items-center gap-2 ml-auto">
        <span id="status-dot" class="w-2.5 h-2.5 rounded-full bg-error"></span>
        <span id="status-label" class="text-xs opacity-70">Disconnected</span>
      </div>
    </header>

    <!-- Connect panel -->
    <div id="connect-panel" class="flex flex-wrap items-end gap-3 px-4 py-3 bg-base-200 border-b border-base-300 shrink-0">
      <div class="form-control">
        <label class="label py-0"><span class="label-text text-xs">Token</span></label>
        <input id="token-input" type="password" placeholder="NoLag token" class="input input-sm input-bordered w-56" />
      </div>
      <div class="form-control">
        <label class="label py-0"><span class="label-text text-xs">Device Name</span></label>
        <input id="device-name-input" type="text" placeholder="my-device" class="input input-sm input-bordered w-36" />
      </div>
      <div class="form-control">
        <label class="label py-0"><span class="label-text text-xs">Role</span></label>
        <select id="role-select" class="select select-sm select-bordered">
          <option value="device">Device</option>
          <option value="controller">Controller</option>
        </select>
      </div>
      <div class="form-control">
        <label class="label py-0"><span class="label-text text-xs">App Name</span></label>
        <input id="app-name-input" type="text" placeholder="iot-demo" class="input input-sm input-bordered w-32" />
      </div>
      <button onclick="window._iotConnect()" class="btn btn-sm btn-primary">Connect</button>
      <button onclick="window._iotDisconnect()" class="btn btn-sm btn-ghost">Disconnect</button>
    </div>

    <!-- Main 3-column layout -->
    <div class="flex flex-1 overflow-hidden">

      <!-- Left sidebar -->
      <aside class="w-56 shrink-0 flex flex-col gap-4 p-3 bg-base-200 border-r border-base-300 overflow-y-auto">
        <div>
          <p class="text-xs font-semibold uppercase opacity-50 mb-2">Groups</p>
          <div id="group-list"><p class="text-xs opacity-50 px-2">Not connected</p></div>
        </div>
        <div>
          <p class="text-xs font-semibold uppercase opacity-50 mb-2">Online Devices</p>
          <div id="online-devices"><p class="text-xs opacity-50 px-2">Not connected</p></div>
        </div>
        <div>
          <p class="text-xs font-semibold uppercase opacity-50 mb-2">Group Members</p>
          <div id="group-devices"><p class="text-xs opacity-50 px-2">Not in a group</p></div>
        </div>
      </aside>

      <!-- Center: DEVICE panel -->
      <main id="device-panel" class="hidden flex-1 flex flex-col gap-4 p-4 overflow-y-auto">

        <!-- Send Telemetry -->
        <div class="card bg-base-200 shadow">
          <div class="card-body p-4">
            <h2 class="card-title text-sm">Send Telemetry</h2>
            <div class="flex flex-wrap items-end gap-3">
              <div class="form-control">
                <label class="label py-0"><span class="label-text text-xs">Sensor</span></label>
                <select id="sensor-select" onchange="onSensorChange()" class="select select-sm select-bordered">
                  <option value="temperature">Temperature</option>
                  <option value="humidity">Humidity</option>
                  <option value="pressure">Pressure</option>
                </select>
              </div>
              <div class="form-control">
                <label class="label py-0"><span class="label-text text-xs">Value</span></label>
                <input id="sensor-value" type="number" step="any" value="22.5" class="input input-sm input-bordered w-28" />
              </div>
              <div class="form-control">
                <label class="label py-0"><span class="label-text text-xs">Unit</span></label>
                <input id="sensor-unit" type="text" value="°C" class="input input-sm input-bordered w-20" />
              </div>
              <button onclick="window._sendTelemetry()" class="btn btn-sm btn-primary">Send</button>
              <button id="auto-send-btn" onclick="window._toggleAutoSend()" class="btn btn-sm btn-secondary">Start Auto-Send</button>
            </div>
          </div>
        </div>

        <!-- Command Inbox -->
        <div class="card bg-base-200 shadow flex-1">
          <div class="card-body p-4">
            <h2 class="card-title text-sm">Command Inbox</h2>
            <div id="command-inbox" class="space-y-2 overflow-y-auto max-h-96">
              <p class="text-xs opacity-50 text-center py-4">No pending commands</p>
            </div>
          </div>
        </div>

      </main>

      <!-- Center: CONTROLLER panel -->
      <main id="controller-panel" class="hidden flex-1 flex flex-col gap-4 p-4 overflow-y-auto">

        <!-- Telemetry Monitor -->
        <div class="card bg-base-200 shadow">
          <div class="card-body p-4">
            <h2 class="card-title text-sm">Telemetry Monitor</h2>
            <div class="overflow-x-auto max-h-64 overflow-y-auto">
              <table class="table table-xs w-full">
                <thead>
                  <tr><th>Device</th><th>Sensor</th><th>Value</th><th>Unit</th><th>Time</th></tr>
                </thead>
                <tbody id="telemetry-tbody">
                  <tr><td colspan="5" class="text-center opacity-50 py-4 text-xs">Waiting for telemetry…</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <!-- Send Command -->
        <div class="card bg-base-200 shadow">
          <div class="card-body p-4">
            <h2 class="card-title text-sm">Send Command</h2>
            <div class="flex flex-wrap items-end gap-3">
              <div class="form-control">
                <label class="label py-0"><span class="label-text text-xs">Target Device</span></label>
                <select id="cmd-target-device" class="select select-sm select-bordered w-48">
                  <option value="">— select device —</option>
                </select>
              </div>
              <div class="form-control">
                <label class="label py-0"><span class="label-text text-xs">Command</span></label>
                <input id="cmd-name" type="text" placeholder="e.g. setThreshold" class="input input-sm input-bordered w-40" />
              </div>
              <div class="form-control">
                <label class="label py-0"><span class="label-text text-xs">Params (JSON)</span></label>
                <input id="cmd-params" type="text" placeholder='{"value":80}' class="input input-sm input-bordered w-40" />
              </div>
              <button onclick="window._sendCommand()" class="btn btn-sm btn-primary">Send</button>
            </div>
          </div>
        </div>

      </main>

      <!-- Right sidebar: event log -->
      <aside class="w-72 shrink-0 flex flex-col bg-base-200 border-l border-base-300 overflow-hidden">
        <div class="flex items-center justify-between px-3 py-2 border-b border-base-300">
          <p class="text-xs font-semibold uppercase opacity-50">Event Log</p>
          <button onclick="document.getElementById('event-log').innerHTML=''" class="text-xs opacity-40 hover:opacity-80">Clear</button>
        </div>
        <div id="event-log" class="flex-1 overflow-y-auto py-1"></div>
      </aside>

    </div>
  </div>
  `;

  // bind globals after DOM is ready
  window._iotConnect     = connect;
  window._iotDisconnect  = disconnect;
  window._sendTelemetry  = sendTelemetry;
  window._toggleAutoSend = toggleAutoSend;
  window._sendCommand    = sendCommand;
  window.onSensorChange  = onSensorChange;

  addLog('IoT Demo ready — enter token and connect', 'action');
}

render();
