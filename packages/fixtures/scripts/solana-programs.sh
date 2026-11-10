#!/usr/bin/env bash
# Load Metaplex Core + Core Candy Machine/Guard into a LOCAL solana-test-validator.
#
#   bash packages/fixtures/scripts/solana-programs.sh dump   # one-time: fetch .so files from devnet
#   bash packages/fixtures/scripts/solana-programs.sh run    # start validator with the programs preloaded
#   bash packages/fixtures/scripts/solana-programs.sh stop
#
# Env: SOLANA_IMAGE (default solanalabs/solana:v1.18.26), RPC_PORT (8899), WS_PORT (8900),
#      CONTAINER (mint-engine-solana-programs), DUMP_CLUSTER (devnet).
# The dump step only READS public program bytes from devnet; tests themselves never touch a public cluster.
# NOTE: recent mpl-core builds may need runtime features newer than the 1.18 validator; if the programs fail
# to load, use a newer validator image (e.g. an Agave 2.x image) via SOLANA_IMAGE.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$HERE/../.programs"
IMAGE="${SOLANA_IMAGE:-solanalabs/solana:v1.18.26}"
RPC_PORT="${RPC_PORT:-8899}"
WS_PORT="${WS_PORT:-8900}"
CONTAINER="${CONTAINER:-mint-engine-solana-programs}"
CLUSTER="${DUMP_CLUSTER:-devnet}"

# Keep in sync with SOLANA_PROGRAMS / SOLANA_PROGRAM_FILES in src/solana/fixtures.ts
PROGRAMS=(
  "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d mpl_core.so"
  "CMACYFENjoBMHzapRXyo1JZkVS6EtaDDzkjMrmQLvr4J mpl_core_candy_machine.so"
  "CMAGAKJ67e9hRZgfC5SFTbZH8MgEmtqazKXjmkaJjWTJ mpl_core_candy_guard.so"
)

# Docker on Git Bash for Windows needs a native path for -v.
mount_path() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else echo "$1"; fi; }

case "${1:-}" in
  dump)
    mkdir -p "$OUT"
    for entry in "${PROGRAMS[@]}"; do
      set -- $entry
      echo "dumping $1 -> .programs/$2 (from $CLUSTER)"
      MSYS_NO_PATHCONV=1 docker run --rm -v "$(mount_path "$OUT"):/programs" --entrypoint solana "$IMAGE" \
        program dump -u "$CLUSTER" "$1" "/programs/$2"
    done
    ;;
  run)
    args=()
    for entry in "${PROGRAMS[@]}"; do
      set -- $entry
      [ -f "$OUT/$2" ] || { echo "missing .programs/$2 - run '$0 dump' first" >&2; exit 1; }
      args+=(--upgradeable-program "$1" "/programs/$2" none)
    done
    MSYS_NO_PATHCONV=1 docker run -d --rm --name "$CONTAINER" -p "$RPC_PORT:8899" -p "$WS_PORT:8900" \
      -v "$(mount_path "$OUT"):/programs:ro" "$IMAGE" \
      solana-test-validator --reset --rpc-port 8899 --bind-address 0.0.0.0 --ledger /tmp/ledger "${args[@]}"
    echo "validator starting on http://127.0.0.1:$RPC_PORT"
    ;;
  stop)
    docker stop "$CONTAINER"
    ;;
  *)
    echo "usage: $0 dump|run|stop" >&2
    exit 2
    ;;
esac
