# Botsman daemon image: Node + git + Claude Code CLI + headless Chromium.
# Runs as root because it owns the Docker socket (trusted orchestrator);
# deployed services themselves run unprivileged in their own containers.
FROM node:22-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
      git curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Coding agent (headless Claude Code). Major version pinned: the wrapper
# depends on CLI flags (-p/--output-format json/--max-turns), so an unreviewed
# major bump must not sneak in via a rebuild.
ARG CLAUDE_CODE_VERSION="^2.0.0"
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"

WORKDIR /opt/botsman

COPY package*.json ./
RUN npm ci --no-audit --no-fund

# Chromium + system deps for screenshots. Fixed path: the daemon may run as a
# non-root UID at runtime, so browsers must not live under build-time $HOME.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx playwright install --with-deps chromium && chmod -R a+rX /ms-playwright

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# All state lives on the mounted volume.
ENV BOTSMAN_HOME=/data
ENV NODE_ENV=production

ENTRYPOINT ["node", "dist/index.js"]
CMD ["start"]
