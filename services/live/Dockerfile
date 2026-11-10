# Build from the repository root: docker build -f services/live/Dockerfile .
# (infra/compose.yaml service live does this). The context is limited by Dockerfile.dockerignore.
# Node 24 runs the TypeScript sources directly (type stripping), so there is no bundle step.
FROM node:24.22.1-alpine3.23@sha256:0468540aa58203ff9e40c2aab3907c52644ab818af6176b1c70a026137dc92a2
ENV NODE_ENV=production COREPACK_ENABLE_DOWNLOAD_PROMPT=0 NODE_OPTIONS=--max-old-space-size=320
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/config/package.json packages/config/
COPY packages/db/package.json packages/db/
COPY packages/geo/package.json packages/geo/
COPY packages/live-frame/package.json packages/live-frame/
COPY packages/schema/package.json packages/schema/
COPY services/live/package.json services/live/
RUN pnpm install --frozen-lockfile --prod --filter "@gerlines/live..." && rm -rf /root/.cache /root/.local/share/pnpm
COPY packages/db packages/db
COPY packages/geo/src packages/geo/src
COPY packages/live-frame/src packages/live-frame/src
COPY packages/schema/src packages/schema/src
COPY services/live/src services/live/src
USER node
WORKDIR /repo/services/live
ENTRYPOINT ["node", "src/cli.ts"]
CMD ["run", "--out", "/live", "--host", "0.0.0.0", "--port", "8790"]
