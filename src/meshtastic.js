export function decodeFromRadio(bytes) {
  const f = fields(bytes);
  const base = { num: f[1]?.u32 };

  if (f[4]) {
    return { ...base, type: 'nodeInfo',     nodeInfo: decodeNodeInfo(f[4].bytes) };
  }
  if (f[3]) {
    const mf = fields(f[3].bytes);
    return { ...base, type: 'myInfo',       myNodeNum: mf[1]?.u32 };
  }
  if (f[8]) {
    return { ...base, type: 'configDone',   configId: f[8]?.u32 };
  }
  if (f[2]) {
    return { ...base, type: 'packet', packet: decodeMeshPacket(f[2].bytes) };
  }
  return { ...base, type: 'other' };
}

const PORT_POSITION  = 3;
const PORT_NODEINFO  = 4;
const PORT_TELEMETRY = 67;

function decodeMeshPacket(bytes) {
  const f = fields(bytes);
  const from   = f[1]?.u32;
  const rxTime = f[7]?.u32;
  const rxSnr  = f[8]?.f32;

  if (!f[4]) return { from, rxTime, rxSnr };

  const data    = fields(f[4].bytes);
  const portnum = data[1]?.u32;
  const payload = data[2]?.bytes;
  if (!payload) return { from, rxTime, rxSnr, portnum };

  let position, user, deviceMetrics;
  switch (portnum) {
    case PORT_POSITION:
      position = decodePosition(payload);
      break;
    case PORT_NODEINFO:
      user = decodeUser(payload);
      break;
    case PORT_TELEMETRY: {
      const tf = fields(payload);
      if (tf[2]) deviceMetrics = decodeDeviceMetrics(tf[2].bytes);
      break;
    }
  }
  return { from, rxTime, rxSnr, portnum, position, user, deviceMetrics };
}

function decodeNodeInfo(bytes) {
  const f = fields(bytes);
  return {
    num:           f[1]?.u32,
    user:          f[2] ? decodeUser(f[2].bytes)          : undefined,
    position:      f[3] ? decodePosition(f[3].bytes)      : undefined,
    snr:           f[4]?.f32,
    lastHeard:     f[5]?.u32,
    deviceMetrics: f[7] ? decodeDeviceMetrics(f[7].bytes) : undefined,
  };
}

function decodeUser(bytes) {
  const f = fields(bytes);
  return {
    id:        f[1]?.str,
    longName:  f[2]?.str,
    shortName: f[3]?.str,
    hwModel:   f[6]?.u32,
  };
}

function decodePosition(bytes) {
  const f = fields(bytes);
  return {
    latitudeI:  f[1]?.i32,
    longitudeI: f[2]?.i32,
    altitude:   f[3]?.i32,
    time:       f[4]?.u32,
    time9:      f[9]?.u32,
  };
}

function decodeDeviceMetrics(bytes) {
  const f = fields(bytes);
  return {
    batteryLevel: f[1]?.u32,
    voltage:      f[2]?.f32,
    channelUtil:  f[3]?.f32,
    airUtilTx:    f[4]?.f32,
  };
}

export function encodeWantConfig(configId) {

  return concatBytes(varintField(3, configId));
}

function fields(buf) {
  const out = {};
  let i = 0;

  while (i < buf.length) {
    const [tag, i1] = varint(buf, i);
    const fieldNum = tag >>> 3;
    const wireType = tag & 0x7;
    i = i1;

    switch (wireType) {
      case 0: {
        const [v, i2] = varint(buf, i);
        out[fieldNum] = { u32: v >>> 0, i32: v | 0, s32: zigzag(v) };
        i = i2;
        break;
      }
      case 2: {
        const [len, i2] = varint(buf, i);
        const b = buf.slice(i2, i2 + len);
        out[fieldNum] = { bytes: b, str: utf8(b) };
        i = i2 + len;
        break;
      }
      case 5: {
        const dv = new DataView(buf.buffer, buf.byteOffset + i, 4);
        out[fieldNum] = { u32: dv.getUint32(0, true), i32: dv.getInt32(0, true), f32: dv.getFloat32(0, true) };
        i += 4;
        break;
      }
      case 1: {
        i += 8;
        break;
      }
      default:
        return out;
    }
  }
  return out;
}

function varint(buf, i) {
  let v = 0, s = 0;
  while (i < buf.length) {
    const b = buf[i++];
    v |= (b & 0x7f) << s;
    if (!(b & 0x80)) return [v >>> 0, i];
    s += 7;
  }
  return [v >>> 0, i];
}

function zigzag(n) { return (n >>> 1) ^ -(n & 1); }

function utf8(bytes) {
  try { return new TextDecoder().decode(bytes); } catch { return ''; }
}

function varintBytes(v) {
  v = v >>> 0;
  const out = [];
  while (v > 0x7f) { out.push((v & 0x7f) | 0x80); v >>>= 7; }
  out.push(v);
  return out;
}

function varintField(fieldNum, value) {
  return [...varintBytes((fieldNum << 3) | 0), ...varintBytes(value)];
}

function concatBytes(...arrays) {
  return new Uint8Array(arrays.flat());
}
