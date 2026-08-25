#!/bin/sh
set -e

# The pool-config bind mount is created root-owned by the Docker daemon on
# first install (the host directory doesn't exist yet when the volume is
# declared), before our container ever gets a say. We start as root
# specifically to fix that up, then drop to the unprivileged `node` user
# (uid 1000, baked into the node:alpine base image) for the actual
# long-running app — application code never runs as root.
CONFIG_DIR="${POOL_CONFIG_DIR:-/data/pool-config}"
mkdir -p "$CONFIG_DIR"
chown -R node:node "$CONFIG_DIR" 2>/dev/null || true

# If the Docker socket is mounted in (DockerControlService uses it to
# restart the zakura container after a mining-address change), make sure
# the unprivileged `node` user can actually reach it. We deliberately don't
# try to match group membership to the socket's owning group here — that
# GID varies between rootful/rootless Docker and across distros, and got
# this wrong once already. Just making the socket world-writable while this
# container runs is blunt but reliable everywhere. It doesn't meaningfully
# widen what THIS container can do — mounting the socket at all already
# grants it full, unrestricted Docker API access (see the security note in
# docker-control.service.ts) — but note it does affect the socket's
# permissions for any other process on the host too, for as long as this
# container is running.
DOCKER_SOCK=/var/run/docker.sock
if [ -S "$DOCKER_SOCK" ]; then
  chmod 666 "$DOCKER_SOCK" 2>/dev/null || true
fi

exec su-exec node:node "$@"
