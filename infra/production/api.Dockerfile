# Build from the repository root: docker build -f infra/production/api.Dockerfile .
# (infra/compose.production.yaml service api does this). The context is limited by api.Dockerfile.dockerignore.
# Node 24 runs the TypeScript sources directly (type stripping), as in services/live/Dockerfile.
FROM node:24.22.1-alpine3.23@sha256:0468540aa58203ff9e40c2aab3907c52644ab818af6176b1c70a026137dc92a2
ENV NODE_ENV=production COREPACK_ENABLE_DOWNLOAD_PROMPT=0 NODE_OPTIONS=--max-old-space-size=1024
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/config/package.json packages/config/
COPY packages/db/package.json packages/db/
COPY packages/schema/package.json packages/schema/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --prod --filter "@gerlines/api..." && rm -rf /root/.cache /root/.local/share/pnpm
COPY packages/db/src packages/db/src
COPY packages/schema/src packages/schema/src
COPY apps/api/src apps/api/src
USER node
WORKDIR /repo/apps/api
EXPOSE 8787
HEALTHCHECK --interval=10s --timeout=5s --retries=6 --start-period=60s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["node", "src/server.ts"]
