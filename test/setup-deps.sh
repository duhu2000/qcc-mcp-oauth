#!/usr/bin/env bash
# 为本仓库的插件级冒烟测试建立指向 DSH host 依赖的符号链接。
# 用法（在 DSH 已安装的本机上）：
#   bash test/setup-deps.sh
# 说明：仅影响 node_modules（已在 .gitignore 中），CI 无 host 依赖时对应测试自动跳过。
set -euo pipefail

DSH_NODE_MODULES="${DSH_NODE_MODULES:-$HOME/.dsh/profiles/node_modules}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"

mkdir -p "$HERE/node_modules/@deepseek-ai"
for p in schemastery dsh-storage-domain dsh-storage cordis dsh-mcp-client dsh-tools; do
  if [ -d "$DSH_NODE_MODULES/@deepseek-ai/$p" ]; then
    ln -sfn "$DSH_NODE_MODULES/@deepseek-ai/$p" "$HERE/node_modules/@deepseek-ai/$p"
    echo "linked @deepseek-ai/$p"
  else
    echo "WARN: @deepseek-ai/$p not found in $DSH_NODE_MODULES (skip)" >&2
  fi
done
if [ -d "$DSH_NODE_MODULES/zod" ]; then
  ln -sfn "$DSH_NODE_MODULES/zod" "$HERE/node_modules/zod"
  echo "linked zod"
else
  echo "WARN: zod not found in $DSH_NODE_MODULES (skip)" >&2
fi
echo "done"
