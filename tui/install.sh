#!/usr/bin/env bash
# Build, check and install opstui. Rust runs in a Podman container
# (Containerfile.build: AlmaLinux 10.2 + AppStream Rust), so the host needs no
# toolchain. The binary lands in ~/.local/bin (override with OPSTUI_BIN_DIR).
#
#   ./install.sh          fmt check, clippy, tests, release build, install
#   ./install.sh check    fmt check, clippy, tests only
#   ./install.sh fmt      apply cargo fmt
set -euo pipefail
cd "$(dirname "$0")"

IMAGE=localhost/opstui-build
DEST=${OPSTUI_BIN_DIR:-$HOME/.local/bin}
CACHE=${XDG_CACHE_HOME:-$HOME/.cache}/opstui-cargo
mode=${1:-install}

if ! podman image exists "$IMAGE"; then
  podman build -t "$IMAGE" -f Containerfile.build .
fi
mkdir -p "$CACHE/registry" "$CACHE/git"

cargo() {
  # label=disable: no SELinux relabeling of the source tree.
  podman run --rm --security-opt label=disable \
    -v "$PWD":/src -v "$CACHE/registry":/root/.cargo/registry -v "$CACHE/git":/root/.cargo/git \
    -w /src "$IMAGE" cargo "$@"
}

case "$mode" in
  fmt) cargo fmt; exit 0 ;;
  check|install) ;;
  *) echo "usage: $0 [install|check|fmt]" >&2; exit 2 ;;
esac

[ -f Cargo.lock ] || cargo generate-lockfile
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
[ "$mode" = check ] && exit 0

cargo build --release --locked
mkdir -p "$DEST"
install -m 0755 target/release/opstui "$DEST/opstui"
echo "Installed $("$DEST/opstui" --version) to $DEST/opstui"
case ":$PATH:" in *":$DEST:"*) ;; *) echo "Note: $DEST is not on PATH" ;; esac
