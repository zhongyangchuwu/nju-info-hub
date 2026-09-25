FROM node:26.10.0-bookworm-slim AS runtime

ARG VERSION=dev
ARG REVISION=unknown
ARG TARGETARCH

LABEL org.opencontainers.image.title="NJU Info Hub" \
      org.opencontainers.image.description="Public, read-only information aggregation for Nanjing University" \
      org.opencontainers.image.source="https://github.com/zhongyangchuwu/nju-info-hub" \
      org.opencontainers.image.version="$VERSION" \
      org.opencontainers.image.revision="$REVISION"

RUN arch="${TARGETARCH:-$(dpkg --print-architecture)}" \
    && case "$arch" in \
      amd64) pnpm_arch=x64 ;; \
      arm64) pnpm_arch=arm64 ;; \
      *) echo "unsupported container architecture: $arch" >&2; exit 1 ;; \
    esac \
    && npm install --global "@pnpm/exe.linux-${pnpm_arch}@12.5.1" --fetch-retries=1 --fetch-timeout=15000 \
    && ln -s "/usr/local/lib/node_modules/@pnpm/exe.linux-${pnpm_arch}/pnpm" /usr/local/bin/pnpm \
    && pnpm --version \
    && npm cache clean --force

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/mcp/package.json apps/mcp/package.json
COPY apps/nju-info/package.json apps/nju-info/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/collector/package.json packages/collector/package.json
COPY packages/instance-config/package.json packages/instance-config/package.json

RUN pnpm install --prod --frozen-lockfile

COPY apps/api/src apps/api/src
COPY apps/worker/src apps/worker/src
COPY apps/mcp/src apps/mcp/src
COPY apps/nju-info/src apps/nju-info/src
COPY packages/core/src packages/core/src
COPY packages/db/src packages/db/src
COPY packages/collector/src packages/collector/src
COPY packages/instance-config/src packages/instance-config/src
COPY sources sources
COPY instances instances
COPY scripts/state-snapshot.mjs /app/scripts/state-snapshot.mjs
COPY scripts/container-entrypoint.sh /usr/local/bin/nju-info

RUN chmod 755 /usr/local/bin/nju-info \
    && rm -f /app/pnpm-workspace.yaml /app/pnpm-lock.yaml /app/node_modules/.pnpm-workspace-state-v1.json /usr/local/bin/pnpm \
    && rm -rf /usr/local/lib/node_modules/@pnpm \
    && mkdir -p /data \
    && chown node:node /data

USER node

ENV NJU_INFO_HOST=0.0.0.0

EXPOSE 3000
VOLUME ["/data"]

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/v1/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/nju-info"]
CMD ["serve"]
