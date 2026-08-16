# ── Stage 1: build the web bundle ─────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# ── Stage 2: lean runtime ─────────────────────────────────────────────────
# Real certs: mount a host directory at /certs via compose (CERT_DIR).
# No certs mounted: falls back to a self-signed cert baked into the image
# (browser will warn, but 8443 will start; useful for LAN dev/test builds).
FROM node:22-alpine
RUN apk add --no-cache openssl
WORKDIR /app

COPY --from=build /app/dist ./dist
COPY server/ ./server/

# Install server runtime dependencies (ws)
RUN cd server && npm install --omit=dev && npm cache clean --force

# Bake in a self-signed cert for dev/blind builds - real certs override via volume
RUN mkdir -p /app/selfsigned && \
    openssl req -x509 -newkey rsa:2048 -days 3650 -nodes \
      -keyout /app/selfsigned/key.pem \
      -out    /app/selfsigned/cert.pem \
      -subj   "/CN=ar-tastic-selfsigned"

EXPOSE 8443 8080

ENV HTTP_PORT=8080
ENV HTTPS_PORT=8443
ENV CERT_DIR=/certs
ENV FALLBACK_CERT_DIR=/app/selfsigned

CMD ["node", "server/index.js"]
