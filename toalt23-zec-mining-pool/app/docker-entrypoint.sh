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
# restart the zakura container after a mining-address change), give the
# unprivileged `node` user access to it via its actual on-host group — we
# match group membership rather than widening the socket's permissions or
# keeping the app running as root just for this one feature.
DOCKER_SOCK=/var/run/docker.sock
if [ -S "$DOCKER_SOCK" ]; then
  SOCK_GID=$(stat -c '%g' "$DOCKER_SOCK" 2>/dev/null || echo "")
  if [ -n "$SOCK_GID" ]; then
    SOCK_GROUP=$(awk -F: -v gid="$SOCK_GID" '$3==gid {print $1; exit}' /etc/group)
    if [ -z "$SOCK_GROUP" ]; then
      addgroup -g "$SOCK_GID" dockerhost 2>/dev/null || true
      SOCK_GROUP=dockerhost
    fi
    addgroup node "$SOCK_GROUP" 2>/dev/null || true
  fi
fi

exec su-exec node:node "$@"
