# syntax=docker/dockerfile:1
# Production image (plan section 5.7, ADR-0005): one Node 24 image. The API bundle serves
# /api/v1, the staff SPA at / and the participant portal at /portal/.
#   docker build -t transfer .
#   docker run ... transfer node dist/migrate.js   # migrations (DATABASE_MIGRATION_URL)
#   docker run ... transfer                        # the server on :8080 (DATABASE_URL, ...)
# The base image is pinned by digest; update tag and digest together.
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5

FROM ${NODE_IMAGE} AS build
ENV CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /repo
# pnpm in the version of package.json's packageManager field.
RUN corepack enable
# Dependencies first, so this layer is cached until the lockfile changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile
# Both SPAs and the API bundle (workspace packages inlined, npm dependencies external).
RUN pnpm build
# Only the API's production npm dependencies; no tsx and no TypeScript at runtime. `--legacy`
# because the workspace doesn't inject workspace packages; the API has none in production.
RUN pnpm deploy --legacy --prod --filter @transfer/api /deploy

FROM ${NODE_IMAGE}
ENV NODE_ENV=production PORT=8080
WORKDIR /app
# The repo's layout, so the bundle finds the SPAs at ../../{web,portal}/dist.
COPY --from=build /deploy/package.json apps/api/package.json
COPY --from=build /deploy/node_modules apps/api/node_modules
COPY --from=build /repo/apps/api/dist apps/api/dist
COPY --from=build /repo/apps/web/dist apps/web/dist
COPY --from=build /repo/apps/portal/dist apps/portal/dist
WORKDIR /app/apps/api
# Files stay owned by root and read-only for the runtime user.
USER node
EXPOSE 8080
CMD ["node", "dist/server.js"]
