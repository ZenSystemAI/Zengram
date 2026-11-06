# Digest-pinned for reproducible builds (node:20-alpine index digest verified
# against the registry via `docker buildx imagetools inspect node:20-alpine`).
FROM node:26-alpine@sha256:8996bb5821d62a8fd9bb27c1cb07462f3fdce6e47d640c6a881ead0b064ce216
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src/ ./src/
COPY scripts/ ./scripts/
RUN mkdir -p /app/data && \
    addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nodejs && \
    chown -R nodejs:nodejs /app/data
USER nodejs
EXPOSE 8084
CMD ["node", "src/index.js"]
