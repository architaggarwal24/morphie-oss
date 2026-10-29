# The Linux image every code project runs in (Cloudflare Containers). Built by `wrangler deploy` (Docker must be running).
FROM docker.io/cloudflare/sandbox:1.0.3 AS shim

FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ripgrep python3 python3-pip python3-venv curl ca-certificates jq build-essential less unzip \
    chromium fonts-liberation \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable
# The helper process that @cloudflare/sandbox's Files and DirectoryBackup talk to.
COPY --from=shim /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
RUN git config --system user.name "Morphie" \
 && git config --system user.email "agent@morphie.local" \
 && git config --system init.defaultBranch main \
 && git config --system safe.directory '*'
# verify_project renders the app's pages in headless Chromium and screenshots them.
ENV CHROME_PATH=/usr/bin/chromium
WORKDIR /workspace/project
