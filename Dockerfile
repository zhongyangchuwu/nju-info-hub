FROM node:26.10.0-bookworm-slim AS build

ARG TARGETARCH

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

WORKDIR /src

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/nju-info/package.json apps/nju-info/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/feed/package.json packages/feed/package.json
COPY packages/collector/package.json packages/collector/package.json
COPY packages/instance-config/package.json packages/instance-config/package.json

RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm build \
    && pnpm --filter @nju-info/nju-info deploy --prod /src/dist/runtime \
    && rm -rf /src/dist/runtime/src /src/dist/runtime/dist /src/dist/runtime/resources /src/dist/runtime/node_modules/@nju-info \
    && find /src/dist/runtime/node_modules/.pnpm -mindepth 1 -maxdepth 1 -type d -name '@nju-info+*' -exec rm -rf {} + \
    && rm -f /src/dist/runtime/tsconfig.json /src/dist/runtime/pnpm-lock.yaml /src/dist/runtime/pnpm-workspace.yaml \
    && rm -f /src/dist/runtime/node_modules/.modules.yaml /src/dist/runtime/node_modules/.pnpm-workspace-state-v1.json /src/dist/runtime/node_modules/.pnpm/lock.yaml \
    && cp -a /src/dist/release/dist /src/dist/runtime/dist \
    && cp -a /src/dist/release/resources /src/dist/runtime/resources \
    && cp /src/dist/release/package.json /src/dist/runtime/package.json \
    && cp /src/dist/release/README.md /src/dist/runtime/README.md

FROM node:26.10.0-bookworm-slim AS runtime

ARG VERSION=dev
ARG REVISION=unknown

LABEL org.opencontainers.image.title="NJU Info Hub" \
      org.opencontainers.image.description="Public, read-only information aggregation for Nanjing University" \
      org.opencontainers.image.source="https://github.com/zhongyangchuwu/nju-info-hub" \
      org.opencontainers.image.version="$VERSION" \
      org.opencontainers.image.revision="$REVISION"

WORKDIR /app

COPY --from=build --chown=node:node /src/dist/runtime/ /app/

RUN ln -s /app/dist/cli.js /usr/local/bin/nju-info \
    && chmod 755 /app/dist/cli.js \
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
