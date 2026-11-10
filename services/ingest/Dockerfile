# Build from the repository root: docker build -f services/ingest/Dockerfile .
# (infra/compose.yaml services recorder and realtime do this). The context is limited by Dockerfile.dockerignore.
FROM node:24.22.2-alpine3.23@sha256:9b69af715c7f9d038150b54ccccbaeffa9064bbc93e2904c29591ca097316af1 AS build
WORKDIR /repo
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/config/package.json packages/config/
COPY packages/db/package.json packages/db/
COPY packages/schema/package.json packages/schema/
COPY services/ingest/package.json services/ingest/
RUN pnpm install --frozen-lockfile --filter "@gerlines/ingest..."
COPY packages/config packages/config
COPY packages/db packages/db
COPY packages/schema packages/schema
COPY services/ingest services/ingest
RUN pnpm --filter @gerlines/ingest build

FROM node:24.22.2-alpine3.23@sha256:9b69af715c7f9d038150b54ccccbaeffa9064bbc93e2904c29591ca097316af1
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /repo/services/ingest/dist/recorder.mjs /app/recorder.mjs
COPY --from=build /repo/services/ingest/dist/realtime.mjs /app/realtime.mjs
COPY --from=build /repo/packages/db/migrations /app/migrations
USER node
ENTRYPOINT ["node", "/app/recorder.mjs"]
CMD ["run"]
