# Paco sandbox image.
#
# This is the container generated apps run in. The Claude Code CLI itself runs on
# the host against the same bind-mounted workspace, so nothing here needs to know
# about the agent — this image only has to run the app.
#
# `release.yml` builds and publishes this on every tag as
# `ghcr.io/stack256org/paco-sandbox`, for amd64 and arm64, and Paco pulls it on
# first use — so an installed host needs nothing from this file.
#
# To build it yourself, tag it as whatever `PACO_SANDBOX_IMAGE` says (see
# ./config.ts), because the pull only happens when the image is absent locally:
#
#   docker build -t ghcr.io/stack256org/paco-sandbox:latest packages/sandbox/docker
#
# There is no fallback to a stock Node image. That fallback was worse than an
# error: workspaces started fine and then failed at the point of use, for want
# of ripgrep or a build toolchain that only this image carries.
FROM node:24-bookworm

# - ripgrep makes the agent's Grep tool fast on large repos.
# - The rest are what generated apps reach for: a Postgres client for psql and
#   libpq-dev builds, plus the usual toolchain for native modules.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    curl \
    git \
    jq \
    libpq-dev \
    openssh-client \
    postgresql-client \
    python3 \
    ripgrep \
    unzip \
  && rm -rf /var/lib/apt/lists/*

# pnpm is the package manager for generated projects, so it must exist in the
# image — instructing the agent to use it without shipping it would just fail.
# Corepack pins the version, so a project's own packageManager field still wins.
ENV PNPM_HOME=/usr/local/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"
RUN corepack enable \
  && corepack prepare pnpm@latest --activate \
  && pnpm --version

# This image runs as the HOST's uid:gid, not as root — see `User:` in
# sandbox.ts. On a Linux bind mount that is what makes files the container
# creates writable by Paco, which runs unprivileged; as root it created
# root-owned files the app then could not touch, and creating them host-side
# instead only moved the failure (git inside the container rejected a
# host-owned repository as "dubious ownership").
#
# That uid is not in this image's /etc/passwd and cannot be, because it is
# whatever the host happens to use. So everything written at runtime has to be
# writable by an unknown uid:
#
#   HOME       `git config --global` writes ~/.gitconfig, and Paco sets a git
#              identity on every sandbox. With no writable HOME that fails, and
#              a sandbox that cannot commit cannot host a chat. Node, pnpm and
#              npm all cache under HOME too.
#   PNPM_HOME  the store every `pnpm install` in a generated project writes to.
#
# 0777 rather than a named user: there is no single uid to grant it to. These
# two paths hold no secrets, the container is disposable and per-session, and
# the workspace itself is a bind mount whose permissions come from the host.
ENV HOME=/home/sandbox
RUN mkdir -p "$HOME" "$PNPM_HOME" \
  && chmod -R 0777 "$HOME" "$PNPM_HOME"

WORKDIR /workspace

# The app's own process is started on demand (the dev server), so the container
# just needs to stay alive and reconnectable.
CMD ["sleep", "infinity"]
