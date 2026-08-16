# AR-tastic: Technical Whitepaper

**Version 0.4.0 · August 2026**

---

## Overview

AR-tastic is a browser-based augmented reality application that overlays Meshtastic LoRa mesh-network nodes as floating MMO-style callout tags on a live camera feed. The app runs entirely in the browser - no native app install required - and is served from a self-hosted Docker container on the local network over HTTPS with a valid TLS certificate.

A user holds their phone up and sees nearby mesh nodes pinned to their real-world positions in space, annotated with callsign, distance, bearing, signal strength, battery level, and last-heard time.

---

## Quick Start

**Requirements:** Docker + Docker Compose on any Linux host on your LAN. Android Chrome for full BLE + AR; iOS Safari is not supported (no Web Bluetooth).

```bash
git clone https://github.com/the-g1ng3r-1/ar-tastic.git
cd ar-tastic
docker compose up -d --build
```

The container exposes two ports:

| Port | Use |
|------|-----|
| 8443 | HTTPS - required for Web Bluetooth and camera on Android Chrome |
| 8080 | HTTP - dev/fallback (camera blocked by browser outside localhost) |

On first launch a self-signed certificate is used. Navigate to `https://<host-ip>:8443` in Android Chrome, accept the certificate warning once, then:

1. Tap **START AR** → grant camera and motion permissions
2. Tap **BLE CONNECT** → pick your Meshtastic radio from the picker
3. Point your phone at the sky or horizon - nodes appear as floating tags

**Using a real certificate (optional):** Place `cert.pem` (full chain) and `key.pem` in a directory on the host, update the volume path in `docker-compose.yml`, and restart the container. Any ACME client with DNS-01 support (acme.sh, certbot) works without exposing the server to the internet.

---

## Architecture

```
┌──────────────────────────────────┐
│         Browser (client)         │
│                                  │
│  Camera feed (getUserMedia)      │
│  DeviceOrientation (compass/IMU) │
│  Web Bluetooth → BLE radio       │
│                                  │
│  Three.js 3D overlay             │
│  ├── NodeTag sprites             │
│  ├── Horizon ring                │
│  └── Clairvoyance beam           │
│                                  │
│  WebSocket (wss://)  ────────────┼──┐
└──────────────────────────────────┘  │
                                       │
┌──────────────────────────────────┐  │
│         Server (Node.js)         │◄─┘
│                                  │
│  Static file server (dist/)      │
│  WebSocket relay + aggregator    │
│  NodeAggregator (triangulation)  │
│  External node ingestion         │
│  ├── meshmap.net (2 min poll)    │
│  └── meshtastic.liamcottle.net   │
│       (5 min poll)               │
└──────────────────────────────────┘
         │
┌────────┴─────────┐
│  Docker container │
│  node:22-alpine   │
│  Ports 8443/8080  │
│  /certs volume    │
└───────────────────┘
```

---

## Data Flow

### Uplink (phone → server)
1. The user taps **BLE CONNECT**. The browser opens a Web Bluetooth picker (`acceptAllDevices: true`) so any OS-paired Meshtastic radio is visible regardless of advertisement state.
2. On connection, the app sends a `want_config_id` protobuf frame to the radio. The radio streams all known `NodeInfo` records over BLE.
3. After the initial config dump, the radio continues pushing live `MeshPacket` traffic over the same BLE link as it relays mesh activity. `POSITION_APP`, `NODEINFO_APP`, and `TELEMETRY_APP` payloads are decoded and merged into the existing node record, so position/name/battery stay current without reconnecting.
4. Each node record is decoded from Meshtastic protobuf (hand-rolled codec in `meshtastic.js` - no npm dependency) and emitted as a `nodeUpdated` DOM event.
5. The `WsTransport` class sends raw node observations and the phone's GPS fix to the server over a persistent WebSocket (`wss://` on HTTPS, `ws://` on HTTP).

### Server aggregation
The server's `NodeAggregator` merges observations from all connected clients:

- **GPS-equipped nodes**: stored as-is with `positionSource: 'gps'`.
- **GPS-less nodes**: position estimated by SNR-weighted centroid across all observers who reported that node. With ≥3 observers it is labelled `triangulated`; with fewer, `estimated`.

On each node update the enriched record is broadcast to all connected clients. A sweep every 15 minutes drops any aggregated or external-feed node whose `lastHeard` is older than 24 hours, along with its stale per-observer triangulation data; a `nodeRemoved` message tells clients to drop it from the registry, scene, and node list.

External node snapshots from meshmap.net and meshtastic.liamcottle.net are fetched on startup and on a rolling interval, then geo-filtered to within 200 km of each client's GPS fix before delivery.

### Downlink (server → phone)
Each `nodeUpdated` WebSocket message updates the `nodeRegistry` in the client and calls `scene.upsertNode()`, which creates or updates a `NodeTag` Three.js group. A `nodeRemoved` message calls `scene.removeNode()` and clears the node from any open detail/list view.

---

## Reliability

- **BLE auto-reconnect**: an unexpected `gattserverdisconnected` triggers automatic reconnection to the same paired radio (no new pairing prompt) with exponential backoff from 1s up to a 30s cap. A manual disconnect is not retried.
- **WebSocket auto-reconnect**: the client's WebSocket connection to the server backs off the same way (1s → 30s cap), resetting to 1s after a successful reconnect.
- **Stale node expiry**: see "Server aggregation" above — nodes not heard from in 24 hours are pruned server-side and removed from every connected client.

---

## Rendering

The render path is always the **camera + DeviceOrientation fallback**:

- A `<video>` element streams the rear camera via `getUserMedia` at up to 1920×1080 and renders behind the canvas (`z-index: 0`).
- A transparent Three.js `WebGLRenderer` canvas sits above it (`z-index: 1`).
- `OrientationManager` listens for `deviceorientationabsolute` (or `deviceorientation` with `webkitCompassHeading` fallback) and converts the Euler angles to a quaternion in the Three.js YXZ convention, compensating for the sensor-to-rear-camera frame rotation and screen orientation angle.
- Each frame the camera's quaternion is overwritten from the device sensors so the 3D scene stays locked to real-world north.

### Coordinate system
North = −Z, East = +X, Up = +Y. GPS positions are converted to Three.js world coordinates with a flat-earth approximation (`gpsTo3D`) using an equirectangular projection scaled by Earth's radius. Nodes beyond 80 km are clamped to 80 km along their bearing to keep them visible without z-fighting.

### Node tags (`NodeTag`)
Each node is a `THREE.Group` containing:
- A **Sprite** with a canvas-texture callout card (512×200 px, drawn each update). The sprite scale is recomputed every frame: `height = max(dist, 50) × 0.112` world units, keeping the tag at a constant ~8% of vertical FOV regardless of distance.
- A vertical **leader line** (green, 50% opacity).
- A pulsing **ring mesh** at the ground anchor point.

The card renders: short name badge, signal-strength bars, long name, distance + cardinal bearing, SNR in dB, battery percentage, and last-heard elapsed time. Border and accent colour are SNR-keyed: green (>5 dB), yellow (>0 dB), orange (>−5 dB), red (≤−5 dB).

### Clairvoyance beam
When a node is selected (via the node list panel or programmatically), a `THREE.Line` is drawn from the camera origin toward the node's direction, extended to 200 km. The beam updates every tick and disappears automatically if the selected node has no GPS fix.

---

## Transport Security

The server starts in dual-port mode when TLS certificates are present:

| Port | Protocol | Use case |
|------|----------|----------|
| 8443 | HTTPS + WSS | Android Chrome (requires secure context for Web Bluetooth and `getUserMedia`) |
| 8080 | HTTP + WS | Fallback / development (camera unavailable outside localhost) |

A self-signed certificate is baked into the image at build time. On a fresh clone, both ports start immediately - browsers will show a one-time trust warning for 8443 which can be clicked through.

To use a real certificate, place `cert.pem` (full chain) and `key.pem` in a host directory and mount it via the `./certs` volume in `docker-compose.yml`. The server prefers the mounted certs over the built-in self-signed cert automatically. Any ACME client (acme.sh, certbot) with a DNS-01 provider works; the server does not need to be internet-accessible.

---

## Build & Deployment

The build uses a two-stage Dockerfile:

1. **Stage 1 (`build`)** - `node:22-alpine`: installs npm dependencies, runs `vite build`, produces a minified bundle in `dist/`.
2. **Stage 2 (runtime)** - `node:22-alpine`: copies `dist/` and `server/`, installs only the server runtime dependency (`ws`), exposes ports 8443 and 8080.

Docker Compose mounts the host cert directory read-only and sets `restart: unless-stopped`.

---

## Software Bill of Materials (SBOM)

### Runtime dependencies (production)

| Package | Version | License | Purpose |
|---------|---------|---------|---------|
| `three` | ^0.184.0 | MIT | 3D rendering (WebGL) |
| `ws` | (latest at install) | MIT | WebSocket server |

### Build / dev dependencies

| Package | Version | License | Purpose |
|---------|---------|---------|---------|
| `vite` | ^8.0.9 | MIT | Module bundler + dev server |

### Runtime platform

| Component | Version | License | Purpose |
|-----------|---------|---------|---------|
| Node.js | 22 (alpine) | MIT / various | JavaScript runtime (server) |
| Alpine Linux | 3.x | MIT / GPL | Container base OS |
| Docker Engine | host | Apache 2.0 | Container runtime |
| Docker Compose | host | Apache 2.0 | Multi-container orchestration |

### External data sources (server-side, network)

| Source | URL | Notes |
|--------|-----|-------|
| meshmap.net | `https://meshmap.net/nodes.json` | Community Meshtastic node map; polled every 2 minutes |
| Liam Cottle API | `https://meshtastic.liamcottle.net/api/v1/nodes` | Alternative node aggregator; polled every 5 minutes |

### Browser APIs used (no npm package)

| API | Secure context required | Notes |
|-----|------------------------|-------|
| Web Bluetooth | Yes (HTTPS or localhost) | BLE radio link to Meshtastic device |
| `MediaDevices.getUserMedia` | Yes | Rear camera feed |
| `DeviceOrientationEvent` | No (iOS: user-gesture permission) | Compass + IMU |
| `WebSocket` | No | Server relay |
| `Geolocation.watchPosition` | No | Phone GPS |
| `Canvas 2D` | No | Node tag texture rendering |
| `WebGL` (Three.js) | No | 3D scene |

---

## Security Notes

- The server's static file handler validates that resolved paths stay within `DIST_DIR` to prevent directory traversal.
- WebSocket messages are parsed with a try/catch; malformed JSON is silently dropped.
- External node data is ingested over HTTPS with a 30-second abort timeout and a `User-Agent` header identifying the application.
- No authentication is implemented; the application is designed for LAN use only.
- The TLS private key is read from the host volume at startup and held in memory for the lifetime of the process.

---

*AR-tastic is open-source software. Meshtastic® is a registered trademark of Meshtastic LLC.*
