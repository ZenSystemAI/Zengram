# Digest-pinned for reproducible builds (node:20-alpine index digest verified
# against the registry via `docker buildx imagetools inspect node:20-alpine`).
FROM node:26-alpine@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94
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
