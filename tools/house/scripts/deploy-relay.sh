#!/usr/bin/env bash
# Copies relay/ into the relay container on the home server and restarts it:
#   tools/house/scripts/deploy-relay.sh
# Goes through Proxmox (pct push), so the container needs no SSH of its own. The token, key and
# env files in /etc/house-relay/ are set up once by hand (README) and never touched here.
set -euo pipefail
PVE="${PVE:-root@192.168.0.235}"
CT="${CT:-102}"
dir="$(cd "$(dirname "$0")/../relay" && pwd)"
files=(relay.mjs ceiling.mjs ceiling.json protocol.mjs automation.mjs house-relay.service)

node -e "import('$dir/ceiling.mjs').then(m => m.validateCeiling(JSON.parse(require('fs').readFileSync('$dir/ceiling.json','utf8'))))" \
  || { echo "ceiling.json is invalid; not deploying" >&2; exit 1; }

stage="/tmp/house-relay.$$"
ssh "$PVE" "mkdir -p $stage"
scp -q "${files[@]/#/$dir/}" "$PVE:$stage/"
ssh "$PVE" bash -s <<EOF
set -euo pipefail
for f in ${files[*]}; do pct push $CT $stage/\$f /opt/house-relay/\$f --perms 0644; done
rm -rf $stage
pct exec $CT -- bash -c 'cp /opt/house-relay/house-relay.service /etc/systemd/system/ && systemctl daemon-reload && systemctl enable --quiet house-relay && systemctl restart house-relay'
sleep 4
pct exec $CT -- journalctl -u house-relay -n 15 --no-pager
EOF
