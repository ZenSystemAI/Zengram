# Digest-pinned for reproducible builds (node:24-alpine index digest verified
# against the registry via `docker buildx imagetools inspect node:24-alpine`).
FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5
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
