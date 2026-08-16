import * as THREE from 'three';

const Q_SENSOR_TO_CAM = new THREE.Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2);
const _euler = new THREE.Euler();
const _zee   = new THREE.Vector3(0, 0, 1);
const _qScreen = new THREE.Quaternion();

export class OrientationManager {
  constructor() {
    this.alpha = 0;
    this.beta  = 90;
    this.gamma = 0;
    this.hasData  = false;
    this.listeners = [];
    this._bound = this._onEvent.bind(this);
  }


  async requestPermission() {
    if (
      typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission === 'function'
    ) {
      const result = await DeviceOrientationEvent.requestPermission();
      if (result !== 'granted') throw new Error('Orientation permission denied');
    }
  }

  start() {
    window.addEventListener('deviceorientationabsolute', this._bound, true);
    window.addEventListener('deviceorientation',         this._bound, true);
  }

  stop() {
    window.removeEventListener('deviceorientationabsolute', this._bound, true);
    window.removeEventListener('deviceorientation',         this._bound, true);
  }

  onUpdate(fn) { this.listeners.push(fn); }

  _onEvent(e) {
    if (e.alpha == null) return;
    this.alpha   = e.absolute ? e.alpha       : (e.webkitCompassHeading ?? e.alpha);
    this.beta    = e.beta  ?? 90;
    this.gamma   = e.gamma ?? 0;
    this.hasData = true;
    this.listeners.forEach(fn => fn(this.alpha, this.beta, this.gamma));
  }


  applyCameraQuaternion(target) {

    _euler.set(
      THREE.MathUtils.degToRad(this.beta),
      THREE.MathUtils.degToRad(this.alpha),
      THREE.MathUtils.degToRad(-this.gamma),
      'YXZ'
    );
    target.setFromEuler(_euler);
    target.multiply(Q_SENSOR_TO_CAM);


    const screenDeg = window.screen?.orientation?.angle ?? window.orientation ?? 0;
    if (screenDeg !== 0) {
      _qScreen.setFromAxisAngle(_zee, -THREE.MathUtils.degToRad(screenDeg));
      target.multiply(_qScreen);
    }
  }
}
