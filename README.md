# Command Center (CC)

A web-based control plane for managing remote Claude Code coding sessions. Create, monitor, and interact with multiple isolated Claude Code instances — each running in its own git worktree — through a centralized dashboard.

## Prerequisites

- Node.js 18+
- [Tailscale](https://tailscale.com/) installed and connected to your tailnet
- Claude Code CLI installed on the host machine
- (Optional) [Codex CLI](https://github.com/openai/codex) installed and authenticated on the host machine if you want to enable the Codex delegation tool

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

CC is now available at `https://<hostname>.tail<id>.ts.net` from any device on your tailnet. Tailscale provisions HTTPS certificates automatically.

If you expose CC behind a custom hostname (e.g. via Tailscale Funnel), set `CC_PUBLIC_URL` to that origin so debug-mode probes from instrumented apps POST back to the right host:

```bash
CC_PUBLIC_URL="https://<hostname>.tail<id>.ts.net" bun run dev
```

When `CC_PUBLIC_URL` is unset, debug-mode falls back to `http://${CC_HOST:-localhost}:${PORT:-3000}`.

To check the current serve config:

```bash
tailscale serve status
```

To stop exposing:

```bash
tailscale serve off
```

## MCP Server Configuration

Command Center reads MCP server definitions from two `.mcp.json` files it owns:

- **Global** — `<CC_CONFIG_DIR>/.mcp.json` (e.g. `~/.config/cc/.mcp.json` on Linux, `~/Library/Application Support/cc/.mcp.json` on macOS). Servers defined here apply to every project.
- **Project** — each worktree's `.mcp.json` at the repository root. Servers defined here apply only to that project.

When the same `serverKey` appears in both files, the project definition overrides the global one.

## Optional: Enable the Codex Tool

CC can expose an MCP tool (`run_codex`) that lets Claude delegate tasks to OpenAI's Codex agent. To enable it, add a `codex` block to your global config file (`~/.config/cc/config.json` on Linux, `~/Library/Application Support/cc/config.json` on macOS):

```json
{
  "codex": {
    "enabled": true,
    "model": "gpt-5-codex",
    "reasoningEffort": "medium"
  }
}
```

- `model` and `reasoningEffort` are optional defaults — Claude can override them per invocation
- Allowed reasoning effort values: `minimal`, `low`, `medium`, `high`, `xhigh`
- CC forces Codex into autonomous `workspace-write` sandbox mode with no approval prompts
- The tool is immediately available in newly created interactive sessions
- Long-lived interactive sessions do not hot-reload Codex config mid-session

## Development

```bash
bun run dev          # Start Next.js dev server
bun run test         # Run tests once
bun run test:watch   # Run tests in watch mode
bun run typecheck    # Type-check without emitting
bun run lint         # Lint with ESLint
bun run format       # Format with Prettier
```
