import * as THREE from 'three';
import { snrColor, formatDistance, toCardinal, formatLastHeard } from './geoUtils.js';

const TAG_W       = 512;
const TAG_H       = 200;
const TAG_SCALE_M = 0.0015;

let _ringGeo = null;
function getRingGeo() {
  if (!_ringGeo) _ringGeo = new THREE.RingGeometry(0.4, 1.0, 48);
  return _ringGeo;
}

export class NodeTag extends THREE.Group {

  constructor(nodeData, myPos) {
    super();

    this._canvas = document.createElement('canvas');
    this._canvas.width  = TAG_W;
    this._canvas.height = TAG_H;
    this._ctx = this._canvas.getContext('2d');
    this._tex = new THREE.CanvasTexture(this._canvas);

    const mat = new THREE.SpriteMaterial({
      map: this._tex,
      transparent: true,
      depthTest: false,
      sizeAttenuation: true,
    });
    this._sprite = new THREE.Sprite(mat);
    this._sprite.scale.set(TAG_W * 0.28, TAG_H * 0.28, 1);
    this._sprite.position.set(0, 0, 0);
    this.add(this._sprite);

    const linePts = [
      new THREE.Vector3(0,  (TAG_H * TAG_SCALE_M) * 0.5, 0),
      new THREE.Vector3(0, -(TAG_H * TAG_SCALE_M) * 0.5 - 2, 0),
    ];
    const lineGeo = new THREE.BufferGeometry().setFromPoints(linePts);
    this._line = new THREE.Line(
      lineGeo,
      new THREE.LineBasicMaterial({ color: 0x00E5FF, transparent: true, opacity: 0.5 })
    );
    this.add(this._line);

    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x00E5FF,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.35,
      depthTest: false,
    });
    this._ring = new THREE.Mesh(getRingGeo(), ringMat);
    this._ring.rotation.x = -Math.PI / 2;
    this._ring.position.y = -(TAG_H * TAG_SCALE_M) * 0.5 - 2;
    this.add(this._ring);

    this._pulse    = 0;
    this._selected = false;
    this._nodeData = null;
    this._myPos    = myPos;

    this.update(nodeData, myPos);
  }


  tick(dt, dist = 500) {
    this._pulse = (this._pulse + dt * 1.2) % (Math.PI * 2);
    const psin = Math.sin(this._pulse);

    const boost = this._selected ? 1.5 : 1.0;
    const h = Math.max(dist, 50) * 0.112 * boost;
    this._sprite.scale.set(h * (TAG_W / TAG_H), h, 1);

    // Ring scaled to ~30% of sprite height so it's always visible
    const ringR = h * 0.30 * (1 + 0.2 * psin);
    this._ring.scale.setScalar(ringR);
    this._ring.material.opacity = this._selected
      ? 0.55 + 0.2 * psin
      : 0.20 + 0.12 * psin;
  }


  update(node, myPos) {
    this._nodeData = node;
    this._myPos = myPos ?? this._myPos;
    this._drawTag(node, this._myPos);
    this._tex.needsUpdate = true;
  }


  setSelected(selected) {
    if (this._selected === selected) return;
    this._selected = selected;
    this._ring.material.color.set(selected ? 0xFFB000 : 0x00E5FF);
    this._drawTag(this._nodeData, this._myPos);
    this._tex.needsUpdate = true;
  }

  setWorldPosition(x, y, z) {
    const minHeight = 8;
    this.position.set(x, Math.max(y, minHeight), z);
  }


  _drawTag(node, myPos) {
    const ctx = this._ctx;
    const W = TAG_W, H = TAG_H;
    ctx.clearRect(0, 0, W, H);

    const isDaemon = node.source === 'daemon';
    const color = isDaemon ? '#cc2200' : snrColor(node.snr);

    // Border — amber+thicker when selected, normal accent color otherwise
    const borderColor  = this._selected ? '#FFB000' : color;
    const borderWidth  = this._selected ? 4 : 2.5;

    const r = 18;
    this._roundRect(ctx, 0, 0, W, H, r);
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    if (isDaemon) {
      bg.addColorStop(0, 'rgba(20, 0, 0, 0.92)');
      bg.addColorStop(1, 'rgba(35, 5, 5, 0.88)');
    } else if (this._selected) {
      bg.addColorStop(0, 'rgba(18, 13, 4, 0.96)');
      bg.addColorStop(1, 'rgba(28, 20, 4, 0.92)');
    } else {
      bg.addColorStop(0, 'rgba(8, 10, 30, 0.92)');
      bg.addColorStop(1, 'rgba(16, 21, 64, 0.88)');
    }
    ctx.fillStyle = bg;
    ctx.fill();

    ctx.strokeStyle = borderColor;
    ctx.lineWidth = borderWidth;
    ctx.stroke();

    // Selected: extra inner glow ring
    if (this._selected) {
      this._roundRect(ctx, 2, 2, W - 4, H - 4, r - 2);
      ctx.strokeStyle = 'rgba(255,176,0,0.25)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Header bar
    this._roundRect(ctx, 0, 0, W, 28, { tl: r, tr: r, bl: 0, br: 0 });
    const bar = ctx.createLinearGradient(0, 0, W, 0);
    bar.addColorStop(0, borderColor + 'cc');
    bar.addColorStop(1, borderColor + '44');
    ctx.fillStyle = bar;
    ctx.fill();

    ctx.fillStyle = isDaemon ? '#cc2200' : (this._selected ? '#FFB000' : color);
    ctx.font = 'bold 18px Courier New';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(isDaemon ? '◈ DARKNET' : (node.shortName ?? '????'), 14, 14);

    this._drawSignalDots(ctx, W - 14, 14, node.snr, borderColor);

    // Long name
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 28px Courier New';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const name = node.longName ?? node.shortName ?? `!${node.num.toString(16)}`;
    ctx.fillText(name, 14, 36, W - 28);

    // Distance + bearing
    ctx.font = '20px Courier New';
    ctx.fillStyle = borderColor;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    let distStr = '-- km', bearStr = '';
    if (myPos?.lat != null && node.lat != null) {
      const { dist, brng } = computeDistBearing(node, myPos);
      distStr = formatDistance(dist);
      bearStr = `  ${toCardinal(brng)}`;
    }
    ctx.fillText(`▶ ${distStr}${bearStr}`, 14, 76);

    // SNR
    if (node.snr != null) {
      ctx.fillStyle = borderColor;
      ctx.font = '18px Courier New';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'top';
      ctx.fillText(`SNR ${node.snr > 0 ? '+' : ''}${node.snr?.toFixed(1)} dB`, W - 14, 76);
    }

    // Footer
    ctx.font = '15px Courier New';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    if (isDaemon) {
      ctx.fillStyle = 'rgba(204,34,0,0.55)';
      ctx.fillText('⬡ PHANTOM NODE', 14, H - 10);
    } else {
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      let footer = '';
      if (node.battery != null) footer += `⚡ ${node.battery}%  `;
      footer += `⏱ ${formatLastHeard(node.lastHeard)}`;
      ctx.fillText(footer, 14, H - 10);
    }

    ctx.textAlign = 'right';
    ctx.fillStyle = isDaemon ? 'rgba(204,34,0,0.4)' : 'rgba(0,229,255,0.3)';
    ctx.fillText(`#${node.num.toString(16).toUpperCase().padStart(8, '0')}`, W - 14, H - 10);

    // Triangle pointer
    const cx = W / 2;
    ctx.beginPath();
    ctx.moveTo(cx - 10, H);
    ctx.lineTo(cx + 10, H);
    ctx.lineTo(cx, H + 14);
    ctx.closePath();
    ctx.fillStyle = borderColor + 'aa';
    ctx.fill();
  }

  _roundRect(ctx, x, y, w, h, r) {
    const radii = typeof r === 'number'
      ? { tl: r, tr: r, br: r, bl: r }
      : r;
    ctx.beginPath();
    ctx.moveTo(x + radii.tl, y);
    ctx.lineTo(x + w - radii.tr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + radii.tr);
    ctx.lineTo(x + w, y + h - radii.br);
    ctx.quadraticCurveTo(x + w, y + h, x + w - radii.br, y + h);
    ctx.lineTo(x + radii.bl, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - radii.bl);
    ctx.lineTo(x, y + radii.tl);
    ctx.quadraticCurveTo(x, y, x + radii.tl, y);
    ctx.closePath();
  }

  _drawSignalDots(ctx, rightX, centerY, snr, color) {
    const bars = 4;
    const bw = 5, gap = 3;
    const totalW = bars * (bw + gap) - gap;
    let active = 0;
    if (snr != null) {
      if (snr > -10) active = 1;
      if (snr > -5)  active = 2;
      if (snr >  0)  active = 3;
      if (snr >  5)  active = 4;
    }
    for (let i = 0; i < bars; i++) {
      const bh = 4 + i * 4;
      const bx = rightX - totalW + i * (bw + gap);
      const by = centerY - bh / 2;
      ctx.fillStyle = i < active ? color : 'rgba(255,255,255,0.2)';
      ctx.fillRect(bx, by, bw, bh);
    }
  }

  dispose() {
    this._tex.dispose();
    this._sprite.material.dispose();
    this._line.geometry.dispose();
    this._line.material.dispose();
    this._ring.material.dispose();
  }
}

function computeDistBearing(node, myPos) {
  const DEG = Math.PI / 180;
  const R = 6371000;
  const lat1 = myPos.lat, lon1 = myPos.lon;
  const lat2 = node.lat,  lon2 = node.lon;
  const dLat = (lat2 - lat1) * DEG;
  const dLon = (lon2 - lon1) * DEG;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*DEG)*Math.cos(lat2*DEG)*Math.sin(dLon/2)**2;
  const dist = 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const y2 = Math.sin(dLon) * Math.cos(lat2*DEG);
  const x2 = Math.cos(lat1*DEG)*Math.sin(lat2*DEG) - Math.sin(lat1*DEG)*Math.cos(lat2*DEG)*Math.cos(dLon);
  const brng = (Math.atan2(y2, x2) / DEG + 360) % 360;
  return { dist, brng };
}
