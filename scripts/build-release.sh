#!/usr/bin/env bash
# scripts/build-release.sh
# 构建两个架构的 Mac 可执行文件并打包为 .tar.gz，附带 sha256

set -euo pipefail

VERSION="${1:-0.1.0}"
OUT="dist/release"

echo "Building swarm-conductor v${VERSION}..."

mkdir -p "$OUT"

# arm64 (Apple Silicon)
echo "  → darwin-arm64"
bun build --compile \
  --target=bun-darwin-arm64 \
  --minify \
  src/cli/index.ts \
  --outfile "$OUT/swarm-conductor-darwin-arm64"

# x86_64 (Intel Mac)
echo "  → darwin-x64"
bun build --compile \
  --target=bun-darwin-x64 \
  --minify \
  src/cli/index.ts \
  --outfile "$OUT/swarm-conductor-darwin-x64"

# 打包 tar.gz
echo "  → packaging"
for ARCH in darwin-arm64 darwin-x64; do
  TARBALL="$OUT/swarm-conductor-${VERSION}-${ARCH}.tar.gz"
  tar -czf "$TARBALL" \
    -C "$OUT" "swarm-conductor-${ARCH}" \
    -C "$(pwd)" README.md LICENSE docs/
  HASH=$(shasum -a 256 "$TARBALL" | awk '{print $1}')
  echo "$HASH  swarm-conductor-${VERSION}-${ARCH}.tar.gz" >> "$OUT/sha256sums.txt"
  echo "    $ARCH: $HASH"
done

echo ""
echo "Release artifacts in $OUT:"
ls -lh "$OUT"
echo ""
echo "sha256sums:"
cat "$OUT/sha256sums.txt"
