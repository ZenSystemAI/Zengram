# Digest-pinned for reproducible builds (node:20-alpine index digest verified
# against the registry via `docker buildx imagetools inspect node:20-alpine`).
FROM node:26-alpine@sha256:e88a35be04478413b7c71c455cd9865de9b9360e1f43456be5951032d7ac1a66
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
