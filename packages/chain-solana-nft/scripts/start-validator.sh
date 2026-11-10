#!/usr/bin/env bash
# Starts a LOCAL solana-test-validator (Docker) with mpl-core and the Core Candy Machine/Guard
# programs loaded. Program binaries are dumped read-only from devnet into ./.programs (gitignored).
#
#   RPC_PORT=21299 WS_PORT=21298 NAME=unit2-solana ./scripts/start-validator.sh
#   E2E_SOLANA_RPC=http://127.0.0.1:21299 E2E_SOLANA_WS=ws://127.0.0.1:21298 npm run e2e -w @mint-engine/chain-solana-nft
#   docker stop unit2-solana
set -euo pipefail
# Git Bash on Windows would otherwise rewrite container paths like /out/x.so.
export MSYS_NO_PATHCONV=1

IMAGE="${IMAGE:-solanalabs/solana:v1.18.26}"
NAME="${NAME:-unit2-solana}"
RPC_PORT="${RPC_PORT:-8899}"
WS_PORT="${WS_PORT:-8900}"
# `pwd -W` gives a Windows path (needed for docker -v under Git Bash); plain pwd elsewhere.
DIR="$(cd "$(dirname "$0")/.." && { pwd -W 2>/dev/null || pwd; })/.programs"
mkdir -p "$DIR"

# name:program-id (bash 3 compatible, no associative arrays)
PROGRAMS="mpl_core:CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d
core_candy_machine:CMACYFENjoBMHzapRXyo1JZkVS6EtaDDzkjMrmQLvr4J
core_candy_guard:CMAGAKJ67e9hRZgfC5SFTbZH8MgEmtqazKXjmkaJjWTJ"

ARGS=()
for entry in $PROGRAMS; do
  name="${entry%%:*}"; id="${entry##*:}"
  if [ ! -s "$DIR/$name.so" ]; then
    docker run --rm -v "$DIR:/out" "$IMAGE" \
      solana program dump --url https://api.devnet.solana.com "$id" "/out/$name.so"
  fi
  ARGS+=(--bpf-program "$id" "/programs/$name.so")
done

docker run -d --rm --name "$NAME" -p "$RPC_PORT:8899" -p "$WS_PORT:8900" -v "$DIR:/programs:ro" "$IMAGE" \
  solana-test-validator --reset --rpc-port 8899 --bind-address 0.0.0.0 --ledger /tmp/ledger "${ARGS[@]}"

echo "waiting for validator on :$RPC_PORT"
for _ in $(seq 1 60); do
  if curl -s -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' \
    "http://127.0.0.1:$RPC_PORT" | grep -q '"ok"'; then echo "ready"; exit 0; fi
  sleep 2
done
echo "validator did not become healthy; stopping $NAME" >&2
docker stop "$NAME" >/dev/null 2>&1 || true
exit 1
