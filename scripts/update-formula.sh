#!/usr/bin/env bash
# scripts/update-formula.sh
# 用法：./scripts/update-formula.sh <version> <arm64-sha256> <x64-sha256>
# 在 CI release workflow 中调用，更新 Formula 里的 sha256

set -euo pipefail

VERSION="$1"
ARM64_SHA="$2"
X64_SHA="$3"
FORMULA="Formula/swarm-conductor.rb"

sed -i '' "s/version \".*\"/version \"${VERSION}\"/" "$FORMULA"
sed -i '' "s/PLACEHOLDER_ARM64_SHA256/${ARM64_SHA}/" "$FORMULA"
sed -i '' "s/PLACEHOLDER_X64_SHA256/${X64_SHA}/"    "$FORMULA"
# 也处理已经是真实 sha256 的情况（第二次 release）
# 用行号锁定替换更安全：arm64 在 on_arm 块，x64 在 on_intel 块
python3 - "$FORMULA" "$ARM64_SHA" "$X64_SHA" <<'PYEOF'
import sys, re

formula_path = sys.argv[1]
arm64_sha    = sys.argv[2]
x64_sha      = sys.argv[3]

text = open(formula_path).read()

# 替换 on_arm 块中的 sha256
text = re.sub(
    r'(on_arm do.*?sha256 ")[a-f0-9]+"',
    rf'\g<1>{arm64_sha}"',
    text, flags=re.DOTALL
)
# 替换 on_intel 块中的 sha256
text = re.sub(
    r'(on_intel do.*?sha256 ")[a-f0-9]+"',
    rf'\g<1>{x64_sha}"',
    text, flags=re.DOTALL
)

open(formula_path, 'w').write(text)
print(f"Updated {formula_path}")
print(f"  arm64: {arm64_sha}")
print(f"  x64:   {x64_sha}")
PYEOF
