FROM node:26.10.0-bookworm-slim AS runtime

ARG VERSION=dev
ARG REVISION=unknown

LABEL org.opencontainers.image.title="NJU Info Hub" \
      org.opencontainers.image.description="Public, read-only information aggregation for Nanjing University" \
      org.opencontainers.image.source="https://github.com/zhongyangchuwu/nju-info-hub" \
      org.opencontainers.image.version="$VERSION" \
      org.opencontainers.image.revision="$REVISION"

RUN npm install --global pnpm@12.5.1 tsx@4.23.15 \
    && npm cache clean --force

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/mcp/package.json apps/mcp/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/collector/package.json packages/collector/package.json
COPY packages/instance-config/package.json packages/instance-config/package.json

RUN pnpm install --prod --frozen-lockfile

COPY apps/api/src apps/api/src
COPY apps/worker/src apps/worker/src
COPY packages/core/src packages/core/src
COPY packages/db/src packages/db/src
COPY packages/collector/src packages/collector/src
COPY packages/instance-config/src packages/instance-config/src
COPY sources sources
COPY instances instances

RUN mkdir -p /data && chown node:node /data

USER node

EXPOSE 3000
VOLUME ["/data"]

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/v1/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["pnpm", "api", "--", "/data/feeds.sqlite", "--host", "0.0.0.0", "--port", "3000"]
