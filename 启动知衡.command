#!/bin/zsh
set -e
cd "$(dirname "$0")"
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
export NEXT_TELEMETRY_DISABLED=1
if ! command -v node >/dev/null; then
  print '需要 Node.js 24.9 或更高版本。请回来后让助手协助安装。'
  read '?按回车退出'; exit 1
fi
if [[ ! -d node_modules ]]; then npm ci; fi
if [[ ! -d runtime/dsh/node_modules ]]; then npm ci --prefix runtime/dsh --ignore-scripts; fi
print '正在构建知衡。数据不会因重新构建而清空。'
npm run build
(sleep 3; open 'http://127.0.0.1:3210') &
print '知衡运行在 http://127.0.0.1:3210 。关闭此终端会停止服务。'
npm start
