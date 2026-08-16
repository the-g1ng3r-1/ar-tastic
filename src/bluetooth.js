import { decodeFromRadio, encodeWantConfig } from './meshtastic.js';

const SERVICE   = '6ba1b218-15a8-461f-9fa8-5d6469fd7fd3';
const FROMRADIO = '8ba2bcc2-ee02-4a55-a531-c525c5e454d5';
const TORADIO   = 'f75c76d2-129e-4dad-a1dd-7866124401e7';
const FROMNUM   = 'ed9da18c-a800-4f66-a670-aa7547e34453';

export class MeshtasticBLE extends EventTarget {
  constructor() {
    super();

    this.nodes     = new Map();
    this.myNum     = null;
    this.myPos     = null;
    this.connected = false;
    this._device   = null;
    this._service  = null;
    this._configId = null;

    this._lastDevice       = null;
    this._listenerAttached = false;
    this._manualDisconnect = false;
    this._reconnecting     = false;
    this._reconnectAttempt = 0;
    this._reconnectTimer   = null;
  }

  async connect() {
    const device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices:  [SERVICE],
    });
    this._manualDisconnect = false;
    this._reconnectAttempt = 0;
    this._listenerAttached = false;
    await this._connectToDevice(device);
  }

  async _connectToDevice(device) {
    this._device     = device;
    this._lastDevice = device;
    if (!this._listenerAttached) {
      device.addEventListener('gattserverdisconnected', () => this._onDisconnect());
      this._listenerAttached = true;
    }

    const server  = await device.gatt.connect();
    this._service = await server.getPrimaryService(SERVICE);


    const fromnum = await this._service.getCharacteristic(FROMNUM);
    await fromnum.startNotifications();
    fromnum.addEventListener('characteristicvaluechanged', () => this._drainFromRadio());


    this._configId = (Math.random() * 0xFFFF_FFFF) >>> 0;
    await this._write(encodeWantConfig(this._configId));


    await this._drainFromRadio();

    this.connected = true;
    this.dispatchEvent(new Event('connected'));
  }

  async disconnect() {
    this._manualDisconnect = true;
    clearTimeout(this._reconnectTimer);
    this._device?.gatt?.disconnect();
    this._reset();
    this.dispatchEvent(new Event('disconnected'));
  }

  _scheduleReconnect() {
    if (this._reconnecting || !this._lastDevice) return;
    this._reconnecting = true;
    const attempt = this._reconnectAttempt + 1;
    const delay   = Math.min(1000 * 2 ** this._reconnectAttempt, 30_000);
    this.dispatchEvent(new CustomEvent('reconnecting', { detail: { attempt, delayMs: delay } }));
    this._reconnectTimer = setTimeout(() => this._attemptReconnect(), delay);
  }

  async _attemptReconnect() {
    this._reconnecting = false;
    this._reconnectAttempt++;
    try {
      await this._connectToDevice(this._lastDevice);
    } catch {
      this._scheduleReconnect();
    }
  }


  async _drainFromRadio() {
    const fromradio = await this._service.getCharacteristic(FROMRADIO);
    while (true) {
      try {
        const dv = await fromradio.readValue();
        if (!dv || dv.byteLength === 0) break;
        this._handle(decodeFromRadio(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength)));
      } catch (_) {
        break;
      }
    }
  }

  _handle(msg) {
    switch (msg.type) {

      case 'myInfo':
        this.myNum = msg.myNodeNum;
        break;

      case 'nodeInfo': {
        const ni = msg.nodeInfo;
        if (!ni?.num) break;
        const existing = this.nodes.get(ni.num) ?? {};
        const pos = ni.position;

        const node = {
          ...existing,
          num:       ni.num,
          longName:  ni.user?.longName  ?? existing.longName  ?? `!${ni.num.toString(16)}`,
          shortName: ni.user?.shortName ?? existing.shortName ?? '????',
          hwModel:   ni.user?.hwModel   ?? existing.hwModel,
          snr:       ni.snr             ?? existing.snr,
          lastHeard: ni.lastHeard       ?? existing.lastHeard,
          battery:   ni.deviceMetrics?.batteryLevel ?? existing.battery,
          ...(pos?.latitudeI != null ? {
            lat: pos.latitudeI  / 1e7,
            lon: pos.longitudeI / 1e7,
            alt: pos.altitude   ?? 0,
          } : {}),
        };

        this.nodes.set(ni.num, node);

        if (ni.num === this.myNum && node.lat != null) {
          this.myPos = { lat: node.lat, lon: node.lon, alt: node.alt };
        }

        this.dispatchEvent(new CustomEvent('nodeUpdated', { detail: node }));
        break;
      }

      case 'configDone':
        if (msg.configId === this._configId) {
          this.dispatchEvent(new Event('configDone'));
        }
        break;

      case 'packet': {
        const p = msg.packet;
        if (!p?.from || (!p.position && !p.user && !p.deviceMetrics)) break;

        const existing = this.nodes.get(p.from) ?? {};
        const node = {
          ...existing,
          num:       p.from,
          lastHeard: p.rxTime ?? Math.floor(Date.now() / 1000),
          snr:       p.rxSnr  ?? existing.snr,
        };
        if (p.user) {
          node.longName  = p.user.longName  ?? existing.longName  ?? `!${p.from.toString(16)}`;
          node.shortName = p.user.shortName ?? existing.shortName ?? '????';
          node.hwModel   = p.user.hwModel   ?? existing.hwModel;
        }
        if (p.position?.latitudeI != null) {
          node.lat = p.position.latitudeI  / 1e7;
          node.lon = p.position.longitudeI / 1e7;
          node.alt = p.position.altitude   ?? 0;
        }
        if (p.deviceMetrics?.batteryLevel != null) node.battery = p.deviceMetrics.batteryLevel;

        this.nodes.set(p.from, node);

        if (p.from === this.myNum && node.lat != null) {
          this.myPos = { lat: node.lat, lon: node.lon, alt: node.alt };
        }

        this.dispatchEvent(new CustomEvent('nodeUpdated', { detail: node }));
        break;
      }
    }
  }

  async _write(bytes) {
    const toradio = await this._service.getCharacteristic(TORADIO);
    await toradio.writeValueWithoutResponse(bytes);
  }

  _onDisconnect() {
    this._reset();
    this.dispatchEvent(new Event('disconnected'));
    if (!this._manualDisconnect) this._scheduleReconnect();
  }

  _reset() {
    this.connected = false;
    this._device   = null;
    this._service  = null;
  }
}
