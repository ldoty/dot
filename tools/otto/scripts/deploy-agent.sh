#!/usr/bin/env bash
# Copies agent/ into Otto's container on the home server and restarts it:
#   tools/otto/scripts/deploy-agent.sh
# Goes through Proxmox (pct push), so the container needs no SSH of its own. Everything lands owned by
# root, read-only to Otto: the code in /opt/otto, its standing instructions (OTTO.md), and Claude Code's
# managed settings, which nothing Otto runs can change. The secrets in /etc/otto are set up once by hand
# (README) and never touched here.
set -euo pipefail
PVE="${PVE:-root@192.168.0.235}"
CT="${CT:-103}"
dir="$(cd "$(dirname "$0")/../agent" && pwd)"
files=(otto.mjs tools.mjs guard.mjs mcp.mjs mcp.json OTTO.md managed-settings.json otto.service)

node -e "JSON.parse(require('fs').readFileSync('$dir/managed-settings.json','utf8')); JSON.parse(require('fs').readFileSync('$dir/mcp.json','utf8'))" \
  || { echo "a settings file is invalid JSON; not deploying" >&2; exit 1; }

stage="/tmp/otto-agent.$$"
ssh "$PVE" "mkdir -p $stage"
# mcp.mjs is a symlink to platform/api: scp copies the file it points at
scp -q "${files[@]/#/$dir/}" "$PVE:$stage/"
ssh "$PVE" bash -s <<EOF
set -euo pipefail
for f in otto.mjs tools.mjs guard.mjs mcp.mjs mcp.json OTTO.md; do pct push $CT $stage/\$f /opt/otto/\$f --perms 0644; done
pct push $CT $stage/managed-settings.json /etc/claude-code/managed-settings.json --perms 0644
pct push $CT $stage/otto.service /etc/systemd/system/otto.service --perms 0644
rm -rf $stage
pct exec $CT -- bash -c 'test -s /etc/otto/env && test -s /etc/otto/agent-key || { echo "set up /etc/otto first (README)" >&2; exit 1; }'
pct exec $CT -- bash -c 'npm install -g --silent @anthropic-ai/claude-code && systemctl daemon-reload && systemctl enable --quiet otto && systemctl restart otto'
sleep 4
pct exec $CT -- journalctl -u otto -n 15 --no-pager
EOF
