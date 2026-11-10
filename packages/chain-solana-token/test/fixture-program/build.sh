#!/usr/bin/env sh
# Build the local-only pump.fun-layout fixture program with Docker (no host Rust/Solana needed).
# Output: test/fixture-program/pump_curve_fixture.so (gitignored build artifacts stay in target/).
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
# Git Bash on Windows: stop MSYS from rewriting the container path.
export MSYS_NO_PATHCONV=1
docker run --rm -v "$HERE:/work" -w /work rust:1.79-bookworm bash -lc '
  set -e
  sh -c "$(curl -sSfL https://release.anza.xyz/v1.18.26/install)" >/dev/null
  export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
  cargo-build-sbf --sbf-out-dir /work/out
  cp /work/out/pump_curve_fixture.so /work/pump_curve_fixture.so
'
echo "built $HERE/pump_curve_fixture.so"
