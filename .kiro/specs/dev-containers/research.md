# Research & Design Decisions

## Summary
- **Feature**: `dev-containers`
- **Discovery Scope**: Complex Integration
- **Key Findings**:
  - `devcontainer up` returns JSON with `containerId`, `remoteUser`, `remoteWorkspaceFolder`, and `outcome` — sufficient for CSM to track and exec into containers
  - `host.docker.internal:host-gateway` (Docker 20.10+) provides reliable cross-platform container-to-host networking for hook delivery
  - Claude Code transcripts must be bind-mounted (not Docker volumes) so CSM can read them from the host without container access

## Research Log

### devcontainer CLI Output and Execution Model
- **Context**: Need to understand how `devcontainer up` reports container info and how `devcontainer exec` handles environment variables.
- **Sources**: [devcontainers/cli GitHub](https://github.com/devcontainers/cli), [VS Code devcontainer docs](https://code.visualstudio.com/docs/devcontainers/containers)
- **Findings**:
  - `devcontainer up --workspace-folder <path>` returns JSON: `{ outcome: "success", containerId: "<hash>", remoteUser: "vscode", remoteWorkspaceFolder: "/workspaces/..." }`
  - `devcontainer exec --workspace-folder <path> <cmd> [args]` executes commands with `remoteUser`, `remoteEnv`, and `userEnvProbe` applied
  - `--remote-env` flag exists but has known issues with variable substitution (GitHub issue #641). Direct env vars via `containerEnv` in devcontainer.json are more reliable.
  - `devcontainer down` exists but is still in-development — Docker CLI `docker stop/rm` is more reliable for cleanup
- **Implications**: CSM captures `containerId` from `devcontainer up` JSON output, uses `devcontainer exec` for Claude CLI execution, and Docker CLI for teardown.

### Container-to-Host Networking
- **Context**: Claude Code hooks inside containers must POST to CSM's `/api/hooks` on the host.
- **Sources**: [Docker host access guide](https://eastondev.com/blog/en/posts/dev/20251217-docker-host-access/), [Baeldung Docker Compose host](https://www.baeldung.com/ops/docker-compose-add-host)
- **Findings**:
  - Docker 20.10+ supports `--add-host=host.docker.internal:host-gateway` which resolves to the host's gateway IP
  - In Docker Compose / devcontainer.json: `"runArgs": ["--add-host=host.docker.internal:host-gateway"]`
  - This is cross-platform: same config works on macOS, Windows, and Linux
  - The firewall init script already allows host network access via `HOST_NETWORK` detection and iptables rules
  - Alternative: `--network=host` eliminates isolation — not acceptable for security model
- **Implications**: CSM's default devcontainer.json includes `--add-host=host.docker.internal:host-gateway` in `runArgs`. Hook scripts use `host.docker.internal:3000` instead of `localhost:3000`.

### Anthropic Reference Dev Container
- **Context**: Understanding the official reference implementation to base CSM's default on.
- **Sources**: [Anthropic devcontainer.json](https://github.com/anthropics/claude-code/blob/main/.devcontainer/devcontainer.json), [Dockerfile](https://github.com/anthropics/claude-code/blob/main/.devcontainer/Dockerfile), [init-firewall.sh](https://github.com/anthropics/claude-code/blob/main/.devcontainer/init-firewall.sh)
- **Findings**:
  - **Dockerfile**: Node.js 20 base, installs Claude Code globally via npm, includes iptables/ipset/iproute2/dnsutils/aggregate for firewall, runs as `node` user, includes zsh/fzf/git-delta for developer experience
  - **devcontainer.json**: Requires `NET_ADMIN` + `NET_RAW` capabilities, mounts bash history and `.claude` config as Docker volumes, sets `DEVCONTAINER=true` env var, runs firewall via `postStartCommand`
  - **init-firewall.sh**: Flushes iptables, preserves Docker DNS, creates ipset allowlist (GitHub API ranges + resolved IPs for npm/Anthropic/Sentry/Statsig/VS Code domains), default-deny policy, verifies by testing blocked/allowed domains
  - Firewall allows: DNS (UDP 53), SSH (TCP 22), localhost, host network, and whitelisted domains only
- **Implications**: CSM ships a modified version of this config. Key changes: (1) add `host.docker.internal:host-gateway` to `runArgs` for hook connectivity, (2) use bind-mounts instead of Docker volumes for `.claude/` so transcripts are host-accessible, (3) CSM port added to firewall allowlist.

### Transcript and Session State Persistence
- **Context**: Claude Code writes transcripts to `~/.claude/projects/<encoded-path>/<session-id>.jsonl`. CSM reads these from the host.
- **Sources**: Codebase analysis of `conversations.ts` (`encodeProjectPath`, `getClaudeProjectDir`)
- **Findings**:
  - Inside the container, Claude writes to `/home/node/.claude/projects/...`
  - The Anthropic reference uses a Docker volume for `.claude/`, which is opaque to the host
  - CSM needs host-side access to read transcripts → must use bind-mount to a host directory
  - Per-session bind-mount: `<csm-data-dir>/containers/<session-id>/.claude` → `/home/node/.claude`
  - `encodeProjectPath` uses the worktree path. Inside the container, the cwd is `/workspace` (the devcontainer default). So the encoded path will be based on `/workspace`, not the host worktree path.
  - CSM's transcript reading code must map between container path encoding (`-workspace`) and the host bind-mount location
- **Implications**: Each session gets a dedicated host directory for `.claude/` data. CSM knows the bind-mount location and reads transcripts directly. The `encodeProjectPath` in existing code doesn't need changes — CSM reads from the known host bind-mount path rather than guessing the Claude internal path.

### Hook Installation Inside Containers
- **Context**: Hooks must be configured inside each container for Claude Code to POST events to CSM.
- **Sources**: Codebase analysis of `install-hooks.ts`
- **Findings**:
  - Current hook script: `cat | curl -s -X POST http://localhost:3000/api/hooks ...`
  - Inside a container, `localhost` refers to the container itself — must use `host.docker.internal`
  - Options: (1) Pre-bake hooks into Dockerfile, (2) Mount host's `~/.claude/settings.json`, (3) Write hooks via `postStartCommand`
  - Option 3 (postStartCommand) is most flexible: CSM generates a container-specific settings.json and hook script, bind-mounts or writes them into the container's `.claude/` directory at startup
  - Since `.claude/` is bind-mounted to a session-specific host directory, CSM can write the settings.json and hook script there before starting the container
- **Implications**: CSM writes hook configuration (settings.json + csm-hook.sh) into the session's `.claude/` host directory before `devcontainer up`. The container picks them up automatically since `.claude/` is bind-mounted.

### devcontainer CLI as Dependency
- **Context**: Evaluating `@devcontainers/cli` as an npm dependency vs. CLI tool.
- **Sources**: [npm @devcontainers/cli](https://www.npmjs.com/package/@devcontainers/cli)
- **Findings**:
  - Available as npm package: `@devcontainers/cli`
  - Requires Node.js 14+, Python, and C/C++ build tools for native dependencies
  - Alternative: install via script (bundles its own Node.js runtime)
  - For CSM, better to require it as a globally installed CLI tool rather than an npm dependency — avoids adding heavy native build dependencies to CSM's package.json
  - CSM can check for `devcontainer` CLI availability at startup similar to how it checks for `claude` CLI
- **Implications**: `devcontainer` CLI is a runtime prerequisite (like Docker and `claude`), not a bundled dependency. CSM checks for its availability at startup.

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| A: devcontainer CLI only | Use `@devcontainers/cli` for all lifecycle operations | Full spec compliance, single tool | `stop`/`down` in development, may be unreliable | Good for up/exec, risky for teardown |
| B: Docker CLI only | Use `docker build/run/exec/stop/rm` directly | Full control, stable API, no extra deps | No devcontainer feature support, more code | Misses ecosystem benefits |
| C: Hybrid (selected) | devcontainer CLI for up/exec, Docker CLI for stop/rm | Best of both: spec compliance + reliable cleanup | Two tools to manage | Container ID from `devcontainer up` bridges the two |

## Design Decisions

### Decision: Hybrid CLI Approach
- **Context**: Need reliable container lifecycle management with devcontainer spec compliance
- **Alternatives Considered**:
  1. devcontainer CLI only — `stop`/`down` are in-development
  2. Docker CLI only — loses devcontainer features/compose support
- **Selected Approach**: Use `devcontainer up`/`exec` for setup and execution, `docker stop/rm` for cleanup
- **Rationale**: `devcontainer up` handles the full spec (features, Dockerfiles, compose, lifecycle commands). `docker stop/rm` is battle-tested for cleanup.
- **Trade-offs**: Two external tools required, but both are standard developer tooling.

### Decision: Bind-Mount for .claude/ Directory
- **Context**: CSM needs host-side access to Claude transcripts written inside the container
- **Alternatives Considered**:
  1. Docker volume (Anthropic default) — host-opaque, requires `docker cp` or exec to read
  2. Bind-mount to session-specific host directory — directly readable from host
- **Selected Approach**: Bind-mount `<csm-data-dir>/containers/<session-hash>/.claude` to `/home/node/.claude`
- **Rationale**: CSM's transcript reading code needs direct filesystem access. Bind-mount provides this without additional tooling.
- **Trade-offs**: Creates per-session directories on host. Must ensure proper cleanup on session deletion.

### Decision: Pre-write Hook Configuration
- **Context**: Claude Code inside containers must have hooks configured to POST to CSM
- **Alternatives Considered**:
  1. Bake hooks into Dockerfile — inflexible, hardcodes CSM URL
  2. Mount host's `~/.claude/settings.json` — shares state across sessions
  3. Pre-write to session's `.claude/` bind-mount before container start
- **Selected Approach**: CSM writes hook configuration (settings.json + hook script) into the session's `.claude/` host directory before `devcontainer up`
- **Rationale**: Since `.claude/` is bind-mounted, files written on the host appear inside the container. No Docker exec needed.
- **Trade-offs**: Hook config is session-specific. CSM must write files before container startup.

### Decision: devcontainer CLI as Runtime Prerequisite
- **Context**: Whether to bundle `@devcontainers/cli` as npm dependency or require it externally
- **Alternatives Considered**:
  1. npm dependency — adds native build deps (Python, C++), heavy
  2. Runtime prerequisite — user installs globally, CSM checks at startup
- **Selected Approach**: Runtime prerequisite, checked at startup alongside Docker
- **Rationale**: Avoids adding native build dependencies to CSM. Consistent with how `claude` CLI is already treated.
- **Trade-offs**: User must install separately. CSM provides guidance in error messages.

## Risks & Mitigations
- **Container build latency** — First-time builds are slow. Mitigate by caching images and showing build progress.
- **Hook connectivity failure** — Container can't reach host. Mitigate with `host.docker.internal:host-gateway` and firewall allowlist.
- **Transcript path mismatch** — Inside vs outside path encoding differs. Mitigate by using known bind-mount paths.
- **Docker/devcontainer CLI not installed** — Mitigate with clear startup checks and error messages.
- **Container state drift** — Container dies while session state says "running". Mitigate with startup reconciliation.

## References
- [Anthropic Claude Code devcontainer](https://github.com/anthropics/claude-code/tree/main/.devcontainer) — Reference implementation
- [Anthropic sandboxing blog](https://www.anthropic.com/engineering/claude-code-sandboxing) — Security architecture
- [Claude Code devcontainer docs](https://code.claude.com/docs/en/devcontainer) — Official documentation
- [devcontainers/cli](https://github.com/devcontainers/cli) — CLI reference implementation
- [Docker host access](https://eastondev.com/blog/en/posts/dev/20251217-docker-host-access/) — host.docker.internal on Linux
