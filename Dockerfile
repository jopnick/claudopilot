# claudopilot/Dockerfile — autonomous Claude Code execution environment.
#
# Builds a Playwright + pnpm@9.0.0 + git + gh + Claude Code image with the
# claudopilot CLI baked in. The host orchestrator launches one of these per
# phase, running `claudopilot __worker` against the per-phase clone mounted at
# /work — no bash engine, nothing vendored into the target repo. The Playwright
# base is here because the host project's Vitest browser-mode tests run real
# Chromium / Firefox / WebKit; if your project doesn't need that, swap to a
# smaller node-based base image.
#
# Build context is the claudopilot PACKAGE root (so `COPY dist/` resolves);
# `claudopilot run` builds it for you (handles context + mounts + flags).
#
# This image is for long-running autonomous execution: Claude Code, gh,
# git push over SSH, safe.directory pre-trusted for /work, and an
# interactive-friendly shell.

# Pinned to match playwright-core@1.59.1 in pnpm-lock.yaml. Bump in
# lockstep whenever @playwright/test is bumped (same rule as the
# sibling Dockerfile).
FROM mcr.microsoft.com/playwright:v1.59.1-noble

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    DEBIAN_FRONTEND=noninteractive

# Any project-specific build-time env vars should be passed at `docker run`
# time via `-e` (forwarded by the engine's RunSpec) rather than baked in.

# System tools the runner needs beyond what the Playwright base ships.
# `jq` is for any agent-side JSON munging; `openssh-client` is required
# for `git push` over SSH (typical in monorepos pushing to a private remote).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git \
      ca-certificates \
      curl \
      openssh-client \
      gnupg \
      jq \
      less \
      netcat-openbsd \
 && rm -rf /var/lib/apt/lists/*

# GitHub CLI. Optional — only used if a future iteration switches the
# loop to PR-merged flow. Pre-installed so the agent has it available
# without a per-tick install.
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | tee /usr/share/keyrings/githubcli-archive-keyring.gpg > /dev/null \
 && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# pnpm pinned to the project's packageManager (see package.json).
# The Playwright Noble image already ships Node + npm, so corepack works.
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate

# Claude Code CLI.
RUN npm install -g @anthropic-ai/claude-code

# ---- Bake the claudopilot engine in -----------------------------------
#
# The bundled CLI (tsup output — dependency-inlined, no node_modules needed)
# is copied in and exposed as `claudopilot` on PATH. The orchestrator runs
# `claudopilot __worker` as each worker container's entrypoint, so there is
# no bash engine to vendor into the target repo.
COPY dist/ /opt/claudopilot/dist/
COPY package.json /opt/claudopilot/package.json
RUN printf '#!/bin/sh\nexec node /opt/claudopilot/dist/cli.js "$@"\n' > /usr/local/bin/claudopilot \
 && chmod +x /usr/local/bin/claudopilot

# Trust the mounted /work directory at the SYSTEM level. Must be
# --system (not --global), because the engine mounts the host's
# ~/.gitconfig read-only over the user's home gitconfig at runtime,
# which would shadow any --global config set during build.
RUN git config --system --add safe.directory /work

# ---- Non-root user for runtime ---------------------------------------
#
# Claude Code refuses --dangerously-skip-permissions (=bypassPermissions)
# when running as root, for safety. The Playwright base runs as root by
# default, so we MUST switch users before launching the loop.
#
# We create a `runner` user whose UID/GID match the host's so files
# created in the bind-mounted /work are owned correctly. Defaults to
# 1000:1000 (typical Ubuntu single-user setup); override with
# --build-arg HOST_UID=$(id -u) --build-arg HOST_GID=$(id -g) — which
# is exactly what `claudopilot run` does automatically.
ARG HOST_UID=1000
ARG HOST_GID=1000

RUN if ! getent group ${HOST_GID} > /dev/null; then \
      groupadd -g ${HOST_GID} runner; \
    fi \
 && if ! id -u ${HOST_UID} > /dev/null 2>&1; then \
      useradd -m -u ${HOST_UID} -g ${HOST_GID} -s /bin/bash runner; \
    fi \
 && mkdir -p /home/runner \
 && chown -R ${HOST_UID}:${HOST_GID} /home/runner

# Quality-of-life prompt for `--shell` mode, written to the runner's
# home so it's picked up after USER switch.
RUN echo 'export PS1="\[\e[36m\][claudopilot]\[\e[0m\] \w \\$ "' >> /home/runner/.bashrc \
 && chown ${HOST_UID}:${HOST_GID} /home/runner/.bashrc

ENV HOME=/home/runner

# Working dir — the host repo is mounted here at runtime by the engine.
WORKDIR /work

# Switch to the non-root user. All subsequent process invocations
# (bash, claude, pnpm, git) run as this UID, so Claude's root-check
# passes and bind-mount writes land with the host owner.
USER ${HOST_UID}:${HOST_GID}

# Default command is bash so a stuck container can be poked at; the
# loop is launched explicitly by `claudopilot run`.
CMD ["bash"]
