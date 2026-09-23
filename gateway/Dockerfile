# jibo-gateway - version comes from package.json (baked in at build)
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8765 \
    DATA_DIR=/data

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

RUN mkdir -p /data && chown node:node /data
USER node

EXPOSE 8765
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8765/healthz >/dev/null || exit 1

CMD ["node", "src/server.js"]
