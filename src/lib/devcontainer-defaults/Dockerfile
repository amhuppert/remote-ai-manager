# CSM Default Dev Container
# Based on Anthropic's reference implementation for Claude Code sandboxing.
# Provides Node.js 20, Claude Code CLI, firewall tools, and non-root user.

FROM node:20-bookworm

# Install firewall and utility packages
RUN apt-get update && apt-get install -y --no-install-recommends \
    iptables \
    ipset \
    iproute2 \
    dnsutils \
    aggregate \
    sudo \
    git \
    curl \
    jq \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI globally
RUN npm install -g @anthropic-ai/claude-code

# Allow node user to run firewall script with sudo (no password)
RUN echo "node ALL=(ALL) NOPASSWD: /usr/local/bin/init-firewall.sh" >> /etc/sudoers.d/node-firewall \
  && chmod 0440 /etc/sudoers.d/node-firewall

# Copy firewall initialization script
COPY init-firewall.sh /usr/local/bin/init-firewall.sh
RUN chmod +x /usr/local/bin/init-firewall.sh

# Switch to non-root user
USER node
WORKDIR /workspace
