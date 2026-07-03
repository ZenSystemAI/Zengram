# Digest-pinned for reproducible builds (node:20-alpine index digest verified
# against the registry via `docker buildx imagetools inspect node:20-alpine`).
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293
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
