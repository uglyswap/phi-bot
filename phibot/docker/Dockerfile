# Phi Bot : image construite à partir du paquet npm publié (spécification, section 14).
# Construction : docker build --build-arg PHIBOT_VERSION=<version> phibot/docker
FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20

ARG PHIBOT_VERSION
ARG PHIBOT_NPM_REGISTRY=https://registry.npmjs.org
ARG PHIBOT_NPM_ALLOW_SCRIPTS=@embedded-postgres/linux-x64,@google/genai,@phi-code-admin/camoufox-js,@phi-code-admin/phi-code,better-sqlite3,cpu-features,onnxruntime-node,protobufjs,sharp,ssh2

LABEL org.opencontainers.image.title="Phi Bot" \
      org.opencontainers.image.description="Phi Bot : orchestrateur d'agents IA dont le moteur est phi" \
      org.opencontainers.image.source="https://github.com/uglyswap/phi-bot" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${PHIBOT_VERSION}"

RUN test -n "${PHIBOT_VERSION}" || { echo "PHIBOT_VERSION manquant : --build-arg PHIBOT_VERSION=<version>" >&2; exit 1; }

# Paquets de la section 6.9 (noms Debian 12), sauf nftables, plus tini.
# hadolint ignore=DL3008
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates curl tar unzip git ripgrep fd-find python3 jq openssh-client xvfb \
      libgtk-3-0 libdbus-glib-1-2 libxt6 libasound2 libx11-xcb1 libxcomposite1 libxcursor1 \
      libxdamage1 libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 libxtst6 \
      libegl1 libgl1-mesa-dri libgbm1 \
      fonts-liberation fonts-noto-color-emoji fonts-wqy-zenhei fontconfig \
      tini \
 && rm -rf /var/lib/apt/lists/*

# Installation npm globale (section 5.4), en root : le code reste en lecture seule pour phibot.
RUN PHI_SKIP_POSTINSTALL=1 CAMOUFOX_SKIP_DOWNLOAD=1 ONNXRUNTIME_NODE_INSTALL_CUDA=skip \
    npm install -g "@phi-code-admin/phi-bot@${PHIBOT_VERSION}" \
      "--registry=${PHIBOT_NPM_REGISTRY}" "--@phi-code-admin:registry=${PHIBOT_NPM_REGISTRY}" \
      --no-audit --no-fund "--allow-scripts=${PHIBOT_NPM_ALLOW_SCRIPTS}" \
 && npm cache clean --force \
 && test "$(node -p "require('/usr/local/lib/node_modules/@phi-code-admin/phi-bot/package.json').version")" = "${PHIBOT_VERSION}"

# Alias des bibliothèques de Postgres embarqué, en root (sections 4.3 et 5.4).
COPY ensure-postgres-aliases.mjs /usr/local/lib/phibot-docker/ensure-postgres-aliases.mjs
RUN node /usr/local/lib/phibot-docker/ensure-postgres-aliases.mjs /usr/local/lib/node_modules/@phi-code-admin/phi-bot

RUN groupadd --system --gid 10001 phibot \
 && useradd --system --uid 10001 --gid 10001 --home-dir /var/lib/phibot --create-home --shell /usr/sbin/nologin phibot \
 && chmod 0700 /var/lib/phibot

ENV HOME=/var/lib/phibot \
    PAPERCLIP_HOME=/var/lib/phibot/.paperclip \
    PAPERCLIP_INSTANCE_ID=default \
    PAPERCLIP_SERVICE_MANAGED=1 \
    PAPERCLIP_DISABLE_CWD_ENV_FILE=true \
    DO_NOT_TRACK=1 \
    TRUST_PROXY=loopback,uniquelocal

USER 10001:10001
WORKDIR /var/lib/phibot
VOLUME ["/var/lib/phibot"]
EXPOSE 3100

HEALTHCHECK --interval=30s --timeout=10s --start-period=30m --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3100/api/health').then((r) => r.json()).then((j) => process.exit(j.status === 'ok' ? 0 : 1), () => process.exit(1))"]

ENTRYPOINT ["tini", "--"]
CMD ["phibot", "setup", "--container"]
