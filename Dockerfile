# Use Docker's bundled frontend; do not download docker/dockerfile from Docker Hub.
ARG NODE_IMAGE=public.ecr.aws/docker/library/node:24-bookworm-slim
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS dependencies
WORKDIR /deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM ${NODE_IMAGE}
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 LOAD_ENV=0
WORKDIR /app
COPY --from=dependencies /deps/node_modules ./node_modules
COPY package.json server.mjs ./
COPY lib/ ./lib/
COPY public/ ./public/
COPY docker/setup-admin.mjs ./docker/setup-admin.mjs
COPY --chown=node:node docker/empty/ ./data/
USER node
VOLUME ["/app/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/api/bootstrap',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "server.mjs"]
