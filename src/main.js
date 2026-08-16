import { OrientationManager }              from './orientation.js';
import { ARScene }                          from './scene.js';
import { MeshtasticBLE }                   from './bluetooth.js';
import { WsTransport }                     from './ws-transport.js';
import { haversineDistance, formatDistance, toCardinal, formatLastHeard } from './geoUtils.js';

console.log('%cDaemon active.', 'color:#cc2200;font-size:20px;font-weight:bold;font-family:monospace');
console.log('%cAwaiting trigger event.  - Matthew Sobol, Cyberstorm Entertainment', 'color:#ff8800;font-size:12px;font-family:monospace');

const $video         = document.getElementById('camera');
const $canvas        = document.getElementById('ar-canvas');
const $overlay       = document.getElementById('overlay');
const $btnStart      = document.getElementById('btn-start');
const $btnConnect    = document.getElementById('btn-connect');
const $statusText    = document.getElementById('status-text');
const $nodeCount     = document.getElementById('node-count');
const $gpsStatus     = document.getElementById('gps-status');
const $headingEl     = document.getElementById('heading-display');
const $toast         = document.getElementById('toast');
const $compass       = document.getElementById('compass');
const $reqCamera     = document.getElementById('req-camera');
const $reqOrient     = document.getElementById('req-orientation');
const $btnNodes      = document.getElementById('btn-nodes');
const $nodePanel     = document.getElementById('node-panel');
const $btnCloseNodes = document.getElementById('btn-close-nodes');
const $nodeSearch    = document.getElementById('node-search');
const $nodeList      = document.getElementById('node-list');
const $rangeSlider   = document.getElementById('range-slider');
const $rangeLabel    = document.getElementById('range-label');
const $nodeDetail      = document.getElementById('node-detail');
const $nodeDetailLong  = document.getElementById('node-detail-long');
const $nodeDetailShort = document.getElementById('node-detail-short');
const $nodeDetailBody  = document.getElementById('node-detail-body');
const $btnCloseDetail  = document.getElementById('btn-close-detail');

let _darknetOn          = false;
let _darknetStatusTimer = null;

$compass.addEventListener('click', () => {
  if (!scene) return;
  _darknetOn = !_darknetOn;
  scene.setDarknetVisible(_darknetOn);
  if (_darknetOn) {
    $statusText.textContent = 'DARKNET ONLINE';
    $toast.textContent = '"The question isn\'t what the Daemon will do. The question is what you\'ll do."';
    $toast.classList.add('show');
    clearTimeout(toastTimer);
    clearTimeout(_darknetStatusTimer);
    toastTimer = setTimeout(() => $toast.classList.remove('show'), 10000);
  } else {
    clearTimeout(_darknetStatusTimer);
    $toast.classList.remove('show');
    $statusText.textContent = _baseStatus;
  }
});

const orientation = new OrientationManager();
const ble         = new MeshtasticBLE();
const transport   = new WsTransport();
let   scene       = null;
let   toastTimer  = null;
let   myPos       = null;
let   _baseStatus = 'OFFLINE';

const nodeRegistry     = new Map();
let   selectedNodeNum  = null;
let   nodeListDebounce = null;

transport.connect();

(async () => {
  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent);
  const hint  = document.getElementById('browser-hint');
  if (!hint) return;
  if (isIOS && !navigator.xr) {
    hint.textContent = '⚠ iOS requires the Mozilla WebXR Viewer app for AR.';
    hint.className = 'hint-warn';
  } else if (navigator.xr && await navigator.xr.isSessionSupported('immersive-ar').catch(() => false)) {
    hint.textContent = '✓ WebXR detected - full AR mode will be used.';
    hint.className = 'hint-ok';
  }
})();

if (!navigator.bluetooth) {
  $btnConnect.title    = 'Web Bluetooth not supported in this browser';
  $btnConnect.disabled = true;
}

function sliderToKm(v) {
  if (v >= 100) return Infinity;

  return Math.round(Math.pow(10, v * 3 / 99)) || 1;
}

$rangeSlider.addEventListener('input', () => {
  const km = sliderToKm(+$rangeSlider.value);
  $rangeLabel.textContent = isFinite(km) ? `${km} km` : '∞';
  scene?.setMaxRange(km);
});

function _ndRow(label, value, cls = '') {
  const row = document.createElement('div');
  row.className = 'nd-row';
  const lbl = document.createElement('span');
  lbl.className = 'nd-label';
  lbl.textContent = label;
  const val = document.createElement('span');
  val.className = 'nd-value' + (cls ? ` ${cls}` : '');
  val.textContent = value;
  row.append(lbl, val);
  return row;
}

function _ndSection(title, rows) {
  const sec = document.createElement('div');
  sec.className = 'nd-section';
  const hdr = document.createElement('div');
  hdr.className = 'nd-section-title';
  hdr.textContent = title;
  sec.appendChild(hdr);
  for (const r of rows) sec.appendChild(_ndRow(...r));
  return sec;
}

function showNodeDetail(num) {
  const node = nodeRegistry.get(num);
  if (!node) return;

  $nodeDetailLong.textContent  = node.longName  ?? `!${node.num.toString(16)}`;
  $nodeDetailShort.textContent = node.shortName ?? '????';
  $nodeDetailBody.innerHTML = '';

  // Signal
  const signalRows = [];
  if (node.snr != null) {
    const cls = node.snr > 0 ? 'good' : node.snr > -10 ? 'warn' : 'weak';
    signalRows.push([`SNR`, `${node.snr > 0 ? '+' : ''}${node.snr.toFixed(2)} dB`, cls]);
  }
  if (node.battery != null) {
    const cls = node.battery > 50 ? 'good' : node.battery > 20 ? 'warn' : 'weak';
    signalRows.push(['Battery', `${node.battery}%`, cls]);
  }
  if (node.lastHeard) signalRows.push(['Last Heard', formatLastHeard(node.lastHeard)]);
  if (signalRows.length) $nodeDetailBody.appendChild(_ndSection('SIGNAL', signalRows));

  // Location
  const locRows = [];
  if (myPos?.lat != null && node.lat != null) {
    const distM = haversineDistance(myPos.lat, myPos.lon, node.lat, node.lon);
    locRows.push(['Distance', formatDistance(distM), 'good']);
    const DEG = Math.PI / 180;
    const dy = Math.sin((node.lon - myPos.lon) * DEG) * Math.cos(node.lat * DEG);
    const dx = Math.cos(myPos.lat * DEG) * Math.sin(node.lat * DEG)
             - Math.sin(myPos.lat * DEG) * Math.cos(node.lat * DEG) * Math.cos((node.lon - myPos.lon) * DEG);
    const brng = (Math.atan2(dy, dx) / DEG + 360) % 360;
    locRows.push(['Bearing', `${Math.round(brng)}°  ${toCardinal(brng)}`]);
  }
  if (node.lat != null) {
    locRows.push(['Latitude',  `${node.lat.toFixed(6)}°`]);
    locRows.push(['Longitude', `${node.lon.toFixed(6)}°`]);
  }
  if (node.alt != null) locRows.push(['Altitude', `${Math.round(node.alt)} m`]);
  if (locRows.length) $nodeDetailBody.appendChild(_ndSection('LOCATION', locRows));

  // Identity
  const idRows = [
    ['Node ID',  node.num.toString(10)],
    ['Hex ID',   `!${node.num.toString(16).padStart(8, '0')}`],
  ];
  if (node.source) idRows.push(['Source', (node.positionSource ?? node.source).toUpperCase()]);
  $nodeDetailBody.appendChild(_ndSection('IDENTITY', idRows));

  // Hardware (optional fields from Meshtastic)
  const hwRows = [];
  if (node.hwModel)        hwRows.push(['Hardware',  node.hwModel]);
  if (node.firmware)       hwRows.push(['Firmware',  node.firmware]);
  if (node.role)           hwRows.push(['Role',      node.role]);
  if (node.hopsAway != null) hwRows.push(['Hops Away', String(node.hopsAway)]);
  if (node.viaMqtt != null)  hwRows.push(['Via MQTT',  node.viaMqtt ? 'Yes' : 'No']);
  if (hwRows.length) $nodeDetailBody.appendChild(_ndSection('HARDWARE', hwRows));

  $nodeDetail.classList.add('open');
}

function hideNodeDetail() {
  $nodeDetail.classList.remove('open');
}

$btnCloseDetail.addEventListener('click', () => {
  selectedNodeNum = null;
  scene?.clearSelection();
  hideNodeDetail();
  if ($nodePanel.classList.contains('open')) renderNodeList($nodeSearch.value);
});

function renderNodeList(filter = '') {
  const f = filter.trim().toLowerCase();
  const rows = [...nodeRegistry.values()]
    .filter(n => !f
      || (n.longName  ?? '').toLowerCase().includes(f)
      || (n.shortName ?? '').toLowerCase().includes(f)
      || n.num.toString(16).includes(f))
    .map(n => {
      const distM = (myPos?.lat != null && n.lat != null)
        ? haversineDistance(myPos.lat, myPos.lon, n.lat, n.lon)
        : null;
      return { ...n, distM };
    })
    .sort((a, b) => (a.distM ?? Infinity) - (b.distM ?? Infinity));

  $nodeList.innerHTML = '';
  for (const n of rows) {
    const li = document.createElement('li');
    if (n.num === selectedNodeNum) li.classList.add('selected');

    const nameDiv = document.createElement('div');
    nameDiv.className = 'node-row-name';
    nameDiv.textContent = n.longName ?? `!${n.num.toString(16)}`;

    const metaDiv = document.createElement('div');
    metaDiv.className = 'node-row-meta';

    const shortSpan = document.createElement('span');
    shortSpan.className = 'node-row-short';
    shortSpan.textContent = n.shortName ?? '????';

    const distSpan = document.createElement('span');
    distSpan.className = 'node-row-dist';
    distSpan.textContent = n.distM != null ? formatDistance(n.distM) : '--';

    metaDiv.append(shortSpan, distSpan);
    li.append(nameDiv, metaDiv);

    li.addEventListener('click', () => {
      if (selectedNodeNum === n.num) {
        selectedNodeNum = null;
        scene?.clearSelection();
        hideNodeDetail();
      } else {
        selectedNodeNum = n.num;
        scene?.selectNode(n.num);
        showNodeDetail(n.num);
      }
      renderNodeList($nodeSearch.value);
    });

    $nodeList.appendChild(li);
  }
}

$btnNodes.addEventListener('click', () => {
  $nodePanel.classList.toggle('open');
  if ($nodePanel.classList.contains('open')) renderNodeList($nodeSearch.value);
});

$btnCloseNodes.addEventListener('click', () => {
  $nodePanel.classList.remove('open');
});

$nodeSearch.addEventListener('input', () => renderNodeList($nodeSearch.value));

$btnStart.addEventListener('click', async () => {
  $btnStart.disabled = true;
  $btnStart.textContent = 'STARTING…';
  try {
    scene = new ARScene($canvas, orientation);
    const mode = await scene.start();
    scene.setDarknetVisible(false);



    try {
      await orientation.requestPermission();
      orientation.start();
      orientation.onUpdate(alpha => {
        $headingEl.textContent = `HDG: ${Math.round(alpha)}°`;
      });
    } catch {  }

    await startCamera();

    $reqCamera.classList.add('done');
    $reqOrient.classList.add('done');

    startCompassDraw();
    startDeviceGPS();

    $overlay.classList.remove('overlay-visible');
    setStatus('READY');
  } catch (err) {
    $btnStart.disabled = false;
    $btnStart.textContent = 'RETRY';
    toast(`⚠ ${err.message}`);
  }
});

$btnConnect.addEventListener('click', async () => {
  if (!scene) { toast('Start AR first'); return; }
  $btnConnect.disabled = true;
  $btnConnect.textContent = 'SCANNING…';
  try {
    await ble.connect();
  } catch (err) {
    $btnConnect.disabled = false;
    $btnConnect.textContent = 'BLE CONNECT';
    toast(`⚠ BLE: ${err.message}`);
  }
});

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    const isHttp = location.protocol === 'http:' && location.hostname !== 'localhost';
    throw new Error(isHttp
      ? 'Camera requires HTTPS on Android - use https://… port 8443 instead'
      : 'Camera (getUserMedia) not available in this browser');
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: { ideal: 'environment' },
      width:  { ideal: 1920 },
      height: { ideal: 1080 },
    },
    audio: false,
  });
  $video.srcObject = stream;
  await new Promise((res, rej) => {
    $video.onloadedmetadata = res;
    $video.onerror = rej;
  });
}

function startDeviceGPS() {
  if (!navigator.geolocation) {
    $gpsStatus.textContent = 'GPS: unavailable';
    return;
  }
  navigator.geolocation.watchPosition(
    pos => {
      myPos = {
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        alt: pos.coords.altitude ?? 0,
      };
      scene?.setMyPosition(myPos);
      transport.sendGPS(myPos);
      $gpsStatus.textContent =
        `GPS: ${myPos.lat.toFixed(5)}, ${myPos.lon.toFixed(5)}`;
    },
    err => { $gpsStatus.textContent = `GPS ERR: ${err.code}`; },
    { enableHighAccuracy: true, maximumAge: 5000 }
  );
}

ble.addEventListener('connected', () => {
  $btnConnect.disabled  = false;
  $btnConnect.textContent = 'BLE ✓';
  setStatus('SYNCING…');
  toast('Radio connected - uploading to server');
});

ble.addEventListener('configDone', () => {
  setStatus(`LIVE - ${ble.nodes.size} nodes uploaded`);
  toast(`Config done - ${ble.nodes.size} nodes sent to server`);
});

ble.addEventListener('disconnected', () => {
  $btnConnect.disabled  = false;
  $btnConnect.textContent = 'BLE RECONNECT';
  setStatus('RADIO OFFLINE');
  toast('BLE disconnected');
});

ble.addEventListener('reconnecting', e => {
  $btnConnect.disabled  = true;
  $btnConnect.textContent = 'RECONNECTING…';
  setStatus(`RADIO OFFLINE - retry ${e.detail.attempt}`);
});

ble.addEventListener('nodeUpdated', e => {
  transport.sendNode(e.detail);
});

$canvas.addEventListener('ar:nodeSelected', e => {
  selectedNodeNum = e.detail;
  if (selectedNodeNum != null) {
    showNodeDetail(selectedNodeNum);
  } else {
    hideNodeDetail();
  }
  if ($nodePanel.classList.contains('open')) renderNodeList($nodeSearch.value);
});

transport.addEventListener('nodeUpdated', e => {
  const node = e.detail;
  nodeRegistry.set(node.num, node);
  scene?.upsertNode(node);
  const n = scene?.nodeCount() ?? 0;
  $nodeCount.textContent = `${n} node${n !== 1 ? 's' : ''}`;
  if ($nodePanel.classList.contains('open')) {
    clearTimeout(nodeListDebounce);
    nodeListDebounce = setTimeout(() => renderNodeList($nodeSearch.value), 200);
  }
});

transport.addEventListener('nodeRemoved', e => {
  const num = e.detail;
  nodeRegistry.delete(num);
  scene?.removeNode(num);
  if (selectedNodeNum === num) {
    selectedNodeNum = null;
    scene?.clearSelection();
    hideNodeDetail();
  }
  const n = scene?.nodeCount() ?? 0;
  $nodeCount.textContent = `${n} node${n !== 1 ? 's' : ''}`;
  if ($nodePanel.classList.contains('open')) renderNodeList($nodeSearch.value);
});

function startCompassDraw() {
  const ctx = $compass.getContext('2d');
  const W = $compass.width, H = $compass.height;

  (function draw() {
    const heading = orientation.alpha;
    ctx.clearRect(0, 0, W, H);

    ctx.beginPath();
    ctx.arc(W/2, H/2, W/2 - 1, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(8,10,30,0.7)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,229,255,0.3)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.save();
    ctx.translate(W/2, H/2);
    ctx.rotate(-heading * Math.PI / 180);

    ['N','E','S','W'].forEach((c, i) => {
      ctx.save();
      ctx.rotate(i * Math.PI / 2);
      ctx.fillStyle = c === 'N' ? '#FF2060' : 'rgba(0,229,255,0.85)';
      ctx.font = `bold ${c === 'N' ? 12 : 9}px Courier New`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(c, 0, -(W/2 - 10));
      ctx.restore();
    });

    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, -(W/2 - 18));
    ctx.strokeStyle = '#FF2060';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, W/2 - 18);
    ctx.strokeStyle = 'rgba(0,229,255,0.5)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.restore();

    ctx.beginPath();
    ctx.arc(W/2, H/2, 3, 0, Math.PI * 2);
    ctx.fillStyle = '#00E5FF';
    ctx.fill();

    requestAnimationFrame(draw);
  })();
}

function setStatus(text) {
  _baseStatus = text;
  if (!_darknetOn) $statusText.textContent = text;
}

function toast(msg) {
  $toast.textContent = msg;
  $toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $toast.classList.remove('show'), 3500);
}
