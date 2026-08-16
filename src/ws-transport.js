export class WsTransport extends EventTarget {
  constructor() {
    super();
    this._ws  = null;
    this._url = null;
    this._reconnectDelay = 1000;
  }

  connect() {

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this._url = `${proto}://${location.host}/ws`;
    this._open();
  }

  sendGPS(pos) {
    this._send({ type: 'gps', pos });
  }

  sendNode(node) {
    this._send({ type: 'node', node });
  }



  _open() {
    const ws = new WebSocket(this._url);
    this._ws = ws;

    ws.addEventListener('open', () => {
      this._reconnectDelay = 1000;
    });

    ws.addEventListener('message', e => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      this._handle(msg);
    });

    ws.addEventListener('close', () => {
      setTimeout(() => this._open(), this._reconnectDelay);
      this._reconnectDelay = Math.min(this._reconnectDelay * 2, 30_000);
    });
  }

  _handle(msg) {
    if (msg.type === 'nodeUpdated') {
      this.dispatchEvent(new CustomEvent('nodeUpdated', { detail: msg.node }));
    } else if (msg.type === 'nodeRemoved') {
      this.dispatchEvent(new CustomEvent('nodeRemoved', { detail: msg.num }));
    }
  }

  _send(obj) {
    if (this._ws?.readyState === 1) this._ws.send(JSON.stringify(obj));
  }
}
