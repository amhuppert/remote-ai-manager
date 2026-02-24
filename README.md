# Claude Session Manager (CSM)

A web-based control plane for managing remote Claude Code coding sessions. Create, monitor, and interact with multiple isolated Claude Code instances — each running in its own git worktree — through a centralized dashboard.

## Prerequisites

- Node.js 18+
- [Tailscale](https://tailscale.com/) installed and connected to your tailnet
- Claude Code CLI installed on the host machine

## Setup

### 1. Install dependencies

```bash
bun install
```

### 2. Allow non-root Tailscale commands (one-time)

```bash
sudo tailscale set --operator=$USER
```

### 3. Start the dev server

```bash
bun run dev
```

### 4. Expose to your Tailscale network

```bash
tailscale serve --bg 3000
```

CSM is now available at `https://<hostname>.tail<id>.ts.net` from any device on your tailnet. Tailscale provisions HTTPS certificates automatically.

To check the current serve config:

```bash
tailscale serve status
```

To stop exposing:

```bash
tailscale serve off
```

## Development

```bash
bun run dev          # Start Next.js dev server
bun run test         # Run tests once
bun run test:watch   # Run tests in watch mode
bun run typecheck    # Type-check without emitting
bun run lint         # Lint with ESLint
bun run format       # Format with Prettier
```
