#!/usr/bin/env bash
# Makes Otto's container on the home server, once (run from a machine that can ssh to Proxmox):
#   tools/otto/scripts/create-container.sh
# An unprivileged Debian container (CT 103 `otto`) with Node 22 and Claude Code, user `otto`, and a firewall
# that lets it reach the internet but nothing else at home (not Home Assistant, not the relay, not
# Proxmox), so whatever Otto reads can't turn it against the house. It holds no AWS credentials.
# After this: put the secrets in /etc/otto (README, "Set up the container"), then deploy-agent.sh.
set -euo pipefail
PVE="${PVE:-root@192.168.0.235}"
CT="${CT:-103}"
STORAGE="${STORAGE:-local-lvm}"
BRIDGE="${BRIDGE:-vmbr0}"

ssh "$PVE" bash -s -- "$CT" "$STORAGE" "$BRIDGE" <<'EOF'
set -euo pipefail
CT=$1 STORAGE=$2 BRIDGE=$3
if pct status "$CT" >/dev/null 2>&1; then echo "CT $CT already exists; not touching it" >&2; exit 1; fi
pveam update >/dev/null
TEMPLATE=$(pveam available --section system | awk '/debian-12-standard/ {print $2}' | sort | tail -1)
[ -f "/var/lib/vz/template/cache/$TEMPLATE" ] || pveam download local "$TEMPLATE"
pct create "$CT" "local:vztmpl/$TEMPLATE" --hostname otto --unprivileged 1 --features nesting=0 \
  --cores 2 --memory 2048 --swap 512 --rootfs "$STORAGE:8" --onboot 1 \
  --net0 "name=eth0,bridge=$BRIDGE,ip=dhcp,firewall=1"

# The internet, and the router for DHCP and DNS; nothing else on the home network
GW=$(ip route | awk '/^default/ {print $3; exit}')
LAN=$(ip -o -f inet route show dev "$BRIDGE" scope link | awk '{print $1; exit}') # the network (192.168.0.0/24), not the host's address
mkdir -p /etc/pve/firewall
# Guest rules apply only with the datacenter firewall on; on, but accepting, so the host and other guests stay as open as before
[ -f /etc/pve/firewall/cluster.fw ] || cat > /etc/pve/firewall/cluster.fw <<FW
[OPTIONS]
# On only so guest rules apply (Otto, CT 103: no home network). Host and other guests stay open as before.
enable: 1
policy_in: ACCEPT
policy_out: ACCEPT
FW
cat > "/etc/pve/firewall/$CT.fw" <<FW
[OPTIONS]
enable: 1
policy_in: DROP
policy_out: ACCEPT

[RULES]
OUT ACCEPT -dest $GW -p udp -dport 53,67
OUT ACCEPT -dest $GW -p tcp -dport 53
OUT DROP -dest $LAN
FW

pct start "$CT"
until pct exec "$CT" -- sh -c 'ip route | grep -q ^default'; do sleep 2; done
pct exec "$CT" -- bash -c '
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -q && apt-get install -yq ca-certificates curl gnupg >/dev/null
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
apt-get install -yq nodejs unattended-upgrades >/dev/null
npm install -g --silent @anthropic-ai/claude-code
id otto >/dev/null 2>&1 || useradd --create-home --shell /usr/sbin/nologin otto
install -d -o otto -g otto -m 0700 /home/otto/work
install -d -o root -g otto -m 0750 /etc/otto
install -d -o root -g root -m 0755 /opt/otto /etc/claude-code
node --version; claude --version
'
echo "CT $CT is up. Next: the secrets in /etc/otto (tools/otto/README.md), then tools/otto/scripts/deploy-agent.sh"
EOF
