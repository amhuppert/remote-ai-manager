#!/usr/bin/env bash
# CSM Firewall Initialization Script
# Adapted from Anthropic's reference implementation for Claude Code sandboxing.
# Sets up iptables rules with a domain allowlist and default-deny policy.
#
# Must be run as root (via sudo) inside the container.

set -euo pipefail

# --- Allowlisted domains ---
ALLOWED_DOMAINS=(
  # Anthropic API
  "api.anthropic.com"
  "statsig.anthropic.com"
  "sentry.io"

  # npm registry
  "registry.npmjs.org"

  # GitHub
  "api.github.com"
  "github.com"
  "raw.githubusercontent.com"

  # Statsig
  "api.statsig.com"
  "featureassets.org"

  # VS Code extensions marketplace
  "marketplace.visualstudio.com"
  "update.code.visualstudio.com"
  "*.vo.msecnd.net"
  "az764295.vo.msecnd.net"

  # PyPI (for Python-based projects)
  "pypi.org"
  "files.pythonhosted.org"
)

echo "=== CSM Firewall Init ==="

# Create ipset for allowed IPs
ipset create allowed_ips hash:ip -exist
ipset flush allowed_ips

# Resolve allowed domains to IPs and add to ipset
for domain in "${ALLOWED_DOMAINS[@]}"; do
  # Skip wildcard domains — resolve the specific ones
  if [[ "$domain" == *"*"* ]]; then
    continue
  fi

  ips=$(dig +short A "$domain" 2>/dev/null | grep -E '^[0-9]+\.' || true)
  for ip in $ips; do
    ipset add allowed_ips "$ip" -exist
    echo "  Allowed: $domain -> $ip"
  done
done

# --- iptables rules ---

# Flush existing OUTPUT rules
iptables -F OUTPUT

# Allow loopback
iptables -A OUTPUT -o lo -j ACCEPT

# Allow established/related connections
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT

# Allow DNS (UDP 53) — required for domain resolution
iptables -A OUTPUT -p udp --dport 53 -j ACCEPT

# Allow SSH (TCP 22)
iptables -A OUTPUT -p tcp --dport 22 -j ACCEPT

# Allow access to host network (host.docker.internal) for hook delivery to CSM
# Docker's host-gateway typically maps to 172.17.0.1 or the bridge gateway
# Filter for IPv4 only since we're using iptables (not ip6tables)
HOST_IP=$(getent ahostsv4 host.docker.internal 2>/dev/null | awk '{print $1; exit}' || true)
if [ -n "$HOST_IP" ]; then
  iptables -A OUTPUT -d "$HOST_IP" -j ACCEPT
  echo "  Allowed: host.docker.internal -> $HOST_IP"
fi

# Allow Docker bridge network (for inter-container and host communication)
GATEWAY_IP=$(ip route | grep default | awk '{print $3}' || true)
if [ -n "$GATEWAY_IP" ]; then
  iptables -A OUTPUT -d "$GATEWAY_IP" -j ACCEPT
  echo "  Allowed: gateway -> $GATEWAY_IP"
fi

# Allow allowlisted IPs
iptables -A OUTPUT -m set --match-set allowed_ips dst -j ACCEPT

# Default deny with REJECT (immediate feedback instead of timeout)
iptables -A OUTPUT -p tcp -j REJECT --reject-with tcp-reset
iptables -A OUTPUT -p udp -j REJECT --reject-with icmp-port-unreachable
iptables -A OUTPUT -j REJECT --reject-with icmp-port-unreachable

echo "=== Firewall rules applied ==="

# --- Verification ---
echo "=== Verifying firewall ==="

# Verify an allowed domain is reachable
if curl -sf --max-time 5 -o /dev/null "https://api.anthropic.com" 2>/dev/null; then
  echo "  PASS: api.anthropic.com is reachable"
else
  echo "  WARN: api.anthropic.com unreachable (may need DNS propagation)"
fi

# Verify a blocked domain is unreachable
if curl -sf --max-time 3 -o /dev/null "https://example.com" 2>/dev/null; then
  echo "  FAIL: example.com should be blocked but is reachable"
else
  echo "  PASS: example.com is correctly blocked"
fi

echo "=== Firewall verification complete ==="
