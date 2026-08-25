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

exec su-exec node:node "$@"
