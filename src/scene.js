import * as THREE from 'three';
import { NodeTag }  from './nodeTag.js';
import { gpsTo3D }  from './geoUtils.js';

const MAX_R = 80_000;

export class ARScene {
  constructor(canvas, orientation) {
    this._canvas      = canvas;
    this._orientation = orientation;
    this._tags        = new Map();
    this._myPos       = null;
    this._running     = false;
    this._lastTime    = 0;
    this._xrMode      = false;
    this._maxRange    = Infinity;
    this._selectedNum = null;
    this._beamLine    = null;

    this._darknetVisible = false;

    this._initRenderer();
    this._initScene();
    this._initPicker();
  }

  setDarknetVisible(visible) {
    this._darknetVisible = visible;
    for (const [, tag] of this._tags) {
      if (tag._nodeData?.source === 'daemon') {
        tag.visible = visible;
      }
    }
  }




  async start() {
    this._startFallback();
    return 'fallback';
  }

  stop() {
    this._running = false;
    this._renderer.setAnimationLoop(null);
  }



  setMyPosition(myPos) {
    this._myPos = myPos;
    for (const [, tag] of this._tags) {
      const node = tag._nodeData;
      if (node?.lat != null && myPos?.lat != null) this._placeTag(tag, node, myPos);
      tag.visible = node?.source === 'daemon' ? this._darknetVisible : this._withinRange(node);
    }
  }

  upsertNode(node) {
    const isDaemon = node.source === 'daemon';
    if (this._tags.has(node.num)) {
      const tag = this._tags.get(node.num);
      tag.update(node, this._myPos);
      if (node.lat != null && this._myPos?.lat != null) this._placeTag(tag, node, this._myPos);
      tag.visible = isDaemon ? this._darknetVisible : this._withinRange(node);
    } else {
      const tag = new NodeTag(node, this._myPos);
      this._tags.set(node.num, tag);
      this._scene.add(tag);
      if (node.lat != null && this._myPos?.lat != null) {
        this._placeTag(tag, node, this._myPos);
      } else {
        tag.position.set(0, 5, -80);
      }
      tag.visible = isDaemon ? this._darknetVisible : this._withinRange(node);
    }
  }

  removeNode(num) {
    const tag = this._tags.get(num);
    if (tag) { this._scene.remove(tag); tag.dispose(); this._tags.delete(num); }
  }

  nodeCount() { return this._tags.size; }

  setMaxRange(km) {
    this._maxRange = isFinite(km) ? km * 1000 : Infinity;
    for (const [, tag] of this._tags) {
      tag.visible = tag._nodeData?.source === 'daemon'
        ? this._darknetVisible
        : this._withinRange(tag._nodeData);
    }
  }

  selectNode(num) {
    if (this._selectedNum && this._selectedNum !== num) {
      this._tags.get(this._selectedNum)?.setSelected(false);
    }
    this._selectedNum = num;
    this._tags.get(num)?.setSelected(true);

    if (!this._beamLine) {
      const positions = new Float32Array(6);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      this._beamLine = new THREE.Line(geo, new THREE.LineBasicMaterial({
        color: 0x44ccff, opacity: 0.75, transparent: true, depthTest: false,
      }));
      this._scene.add(this._beamLine);
    }
    this._updateBeam();
  }

  clearSelection() {
    if (this._selectedNum) {
      this._tags.get(this._selectedNum)?.setSelected(false);
    }
    this._selectedNum = null;
    if (this._beamLine) this._beamLine.visible = false;
  }



  async _startWebXR() {
    const opts = { requiredFeatures: ['local'] };
    const uiEl = document.getElementById('ui');
    if (uiEl) {
      opts.optionalFeatures = ['dom-overlay'];
      opts.domOverlay = { root: uiEl };
    }

    const session = await navigator.xr.requestSession('immersive-ar', opts);
    this._renderer.xr.enabled = true;
    await this._renderer.xr.setSession(session);

    this._xrMode = true;
    this._running = true;

    this._renderer.setAnimationLoop((t) => {
      const dt = Math.min((t - this._lastTime) / 1000, 0.1);
      this._lastTime = t;
      this._tickXR(dt);
    });
  }

  _startFallback() {
    this._running  = true;
    this._lastTime = performance.now();
    this._loop();
  }

  _loop() {
    if (!this._running) return;
    requestAnimationFrame(t => {
      const dt = Math.min((t - this._lastTime) / 1000, 0.1);
      this._lastTime = t;
      this._tickFallback(dt);
      this._loop();
    });
  }

  _tickXR(dt) {
    for (const tag of this._tags.values()) tag.tick(dt, tag.position.length());
    this._updateBeam();
    this._renderer.render(this._scene, this._camera);
  }

  _tickFallback(dt) {
    this._orientation.applyCameraQuaternion(this._camera.quaternion);
    for (const tag of this._tags.values()) tag.tick(dt, tag.position.length());
    this._updateBeam();
    this._renderer.render(this._scene, this._camera);
  }



  _updateBeam() {
    if (!this._selectedNum || !this._beamLine) return;
    const tag = this._tags.get(this._selectedNum);
    if (!tag || tag._nodeData?.lat == null) { this._beamLine.visible = false; return; }
    const dir = tag.position.clone().normalize().multiplyScalar(200_000);
    const pos = this._beamLine.geometry.attributes.position;
    pos.setXYZ(0, 0, -1, 0);
    pos.setXYZ(1, dir.x, dir.y, dir.z);
    pos.needsUpdate = true;
    this._beamLine.visible = true;
  }



  _withinRange(node) {
    if (!isFinite(this._maxRange)) return true;
    if (!this._myPos?.lat || node?.lat == null) return true;
    const { x, z } = gpsTo3D(this._myPos.lat, this._myPos.lon, 0, node.lat, node.lon, 0);
    return Math.sqrt(x * x + z * z) <= this._maxRange;
  }



  _initPicker() {
    const pick = (clientX, clientY) => {
      const rect = this._canvas.getBoundingClientRect();
      const ndcX =  (clientX - rect.left) / rect.width  * 2 - 1;
      const ndcY = -((clientY - rect.top)  / rect.height * 2 - 1);
      this._pickNode(ndcX, ndcY);
    };
    this._canvas.addEventListener('click', e => pick(e.clientX, e.clientY));
    this._canvas.addEventListener('touchend', e => {
      if (e.changedTouches.length !== 1) return;
      e.preventDefault();
      const t = e.changedTouches[0];
      pick(t.clientX, t.clientY);
    }, { passive: false });
  }

  _pickNode(ndcX, ndcY) {
    if (!this._running) return;
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera({ x: ndcX, y: ndcY }, this._camera);

    const sprites = [];
    for (const [, tag] of this._tags) {
      if (tag.visible) sprites.push(tag._sprite);
    }

    const hits = raycaster.intersectObjects(sprites);
    if (hits.length) {
      const hit = hits[0].object;
      for (const [num, tag] of this._tags) {
        if (tag._sprite === hit) {
          if (this._selectedNum === num) {
            this.clearSelection();
            this._canvas.dispatchEvent(new CustomEvent('ar:nodeSelected', { detail: null, bubbles: true }));
          } else {
            this.selectNode(num);
            this._canvas.dispatchEvent(new CustomEvent('ar:nodeSelected', { detail: num, bubbles: true }));
          }
          return;
        }
      }
    }
    // Tap on empty space — deselect
    if (this._selectedNum != null) {
      this.clearSelection();
      this._canvas.dispatchEvent(new CustomEvent('ar:nodeSelected', { detail: null, bubbles: true }));
    }
  }

  _initRenderer() {
    this._renderer = new THREE.WebGLRenderer({
      canvas:               this._canvas,
      alpha:                true,
      antialias:            true,
      logarithmicDepthBuffer: true,
    });
    this._renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this._renderer.setClearColor(0x000000, 0);
    this._renderer.sortObjects = false;
    this._resize();
    window.addEventListener('resize', () => { if (!this._xrMode) this._resize(); });
  }

  _initScene() {
    this._scene  = new THREE.Scene();
    this._camera = new THREE.PerspectiveCamera(70, this._aspect(), 0.5, 200_000);
    this._camera.position.set(0, 0, 0);
    this._scene.add(new THREE.AmbientLight(0x00E5FF, 0.3));
    this._addHorizonGrid();
  }

  _addHorizonGrid() {

    const pts = [];
    const N = 128, radius = 3000;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.sin(a) * radius, -2, Math.cos(a) * radius));
    }
    this._scene.add(new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: 0x00E5FF, opacity: 0.35, transparent: true, depthTest: false }),
    ));

    for (const [label, x, z] of [['N',0,-1000],['S',0,1000],['E',1000,0],['W',-1000,0]]) {
      const s = this._makeTextSprite(label, '#00E5FF99', 80);
      s.position.set(x, -2, z);
      s.scale.set(80, 80, 1);
      this._scene.add(s);
    }
  }

  _makeTextSprite(text, color, size) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 128;
    const c = cv.getContext('2d');
    c.fillStyle = color;
    c.font = `bold ${size}px Courier New`;
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(text, 64, 64);
    const tex = new THREE.CanvasTexture(cv);
    return new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  }

  _placeTag(tag, node, myPos) {
    const { x, y, z } = gpsTo3D(myPos.lat, myPos.lon, myPos.alt ?? 0,
                                 node.lat,  node.lon,  node.alt  ?? 0);
    const dist  = Math.sqrt(x*x + z*z);
    const scale = dist > MAX_R ? MAX_R / dist : 1;
    tag.setWorldPosition(x * scale, y, z * scale);
  }

  _aspect()  { return this._canvas.clientWidth / (this._canvas.clientHeight || 1); }

  _resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this._renderer.setSize(w, h, false);
    if (this._camera) { this._camera.aspect = w / h; this._camera.updateProjectionMatrix(); }
  }
}
