#!/bin/sh
set -eu

if [ -z "${YOUTUBE_OAUTH_REFRESH_TOKEN:-}" ]; then
  echo "ERRO: YOUTUBE_OAUTH_REFRESH_TOKEN é obrigatório. Gere o token com application-oauth-setup.yml e tente novamente." >&2
  exit 78
fi

JAR="${LAVALINK_JAR:-Lavalink.jar}"
exec java -jar "$JAR"
