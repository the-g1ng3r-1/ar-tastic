const R = 6371000;
const DEG = Math.PI / 180;

export function gpsTo3D(refLat, refLon, refAlt = 0, nodeLat, nodeLon, nodeAlt = 0) {
  const x =  R * (nodeLon - refLon) * DEG * Math.cos(refLat * DEG);
  const z = -R * (nodeLat - refLat) * DEG;
  const y = nodeAlt - refAlt;
  return { x, y, z };
}

export function haversineDistance(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * DEG;
  const dLon = (lon2 - lon1) * DEG;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function bearing(lat1, lon1, lat2, lon2) {
  const dLon = (lon2 - lon1) * DEG;
  const y = Math.sin(dLon) * Math.cos(lat2 * DEG);
  const x =
    Math.cos(lat1 * DEG) * Math.sin(lat2 * DEG) -
    Math.sin(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.cos(dLon);
  return (Math.atan2(y, x) / DEG + 360) % 360;
}

export function formatDistance(meters) {
  if (meters >= 1000) return `${(meters / 1000).toFixed(1)} km`;
  return `${Math.round(meters)} m`;
}

const CARDINALS = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
export function toCardinal(deg) {
  return CARDINALS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
}

export function formatLastHeard(unixSeconds) {
  if (!unixSeconds) return '?';
  const s = Math.floor(Date.now() / 1000) - unixSeconds;
  if (s < 60)    return `${s}s`;
  if (s < 3600)  return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function snrColor(snr) {
  if (snr == null) return '#3A5080';
  if (snr > 5)  return '#00E5FF';
  if (snr > 0)  return '#FFB000';
  if (snr > -5) return '#FF00FF';
  return '#FF2060';
}
