# Init Script Reference

## When It Runs

1. User creates a new session (Fast or Focus mode)
2. Command Center creates the git worktree and branch
3. **The init script executes**
4. Success (exit 0) → session is ready
5. Failure (non-zero exit) → session creation rolled back (worktree removed, session deleted)

## Execution Contract

| Property | Value |
|---|---|
| Working directory | The newly created worktree path |
| Timeout | 60 seconds |
| Execution method | Direct execution via `execFile` (NOT shell) — **must have a shebang line** |
| Permissions | Must be executable (`chmod +x`) |
| Exit 0 | Success — session becomes usable |
| Non-zero exit | Failure — full rollback |

## Environment Variables

| Variable | Value | Description |
|---|---|---|
| `PROJECT_ROOT` | `/home/user/repos/my-project` | Absolute path to the original project root |
| `CLAUDE_PROJECT_DIR` | `/home/user/repos/my-project` | Same as `PROJECT_ROOT` |
| `WORKTREE_PATH` | `/home/user/repos/my-project/.worktrees/my-session` | Absolute path to the session worktree |
| `SESSION_NAME` | `my-session` | Session identifier |
| `BRANCH_NAME` | `csm/my-session` | Git branch created for this session |

**Stripped variables:** `NODE_ENV` is intentionally unset so package managers use their defaults (e.g., dev dependencies are installed). `__NEXT_*` and `__TURBOPACK_*` internal variables are also stripped to prevent conflicts with child processes.

## Templates by Package Manager

### bun

```bash
#!/usr/bin/env bash
set -euo pipefail
echo "Installing dependencies in worktree: $WORKTREE_PATH"
bun install
```

### npm

```bash
#!/usr/bin/env bash
set -euo pipefail
echo "Installing dependencies in worktree: $WORKTREE_PATH"
npm ci
```

### pnpm

```bash
#!/usr/bin/env bash
set -euo pipefail
echo "Installing dependencies in worktree: $WORKTREE_PATH"
pnpm install --frozen-lockfile
```

### yarn (v1)

```bash
#!/usr/bin/env bash
set -euo pipefail
echo "Installing dependencies in worktree: $WORKTREE_PATH"
yarn install --frozen-lockfile
```

### yarn (Berry / v3+)

Detected by the presence of `.yarnrc.yml` in the project root.

```bash
#!/usr/bin/env bash
set -euo pipefail
echo "Installing dependencies in worktree: $WORKTREE_PATH"
yarn install --immutable
```

## Extended Template

For projects with code generation or environment setup:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Install dependencies
npm ci

# Copy environment file if it doesn't exist
if [ ! -f .env.local ]; then
  cp "$PROJECT_ROOT/.env.example" .env.local
fi

# Run code generation
npx prisma generate
```

## Key Rules

- The script runs with cwd set to the worktree, so `npm ci` / `bun install` work automatically
- Stdout and stderr are not shown to the user on success; on failure, the error is included in the response
- Keep scripts fast — the 60-second timeout is strict
- Use `set -euo pipefail` to fail fast on any error
