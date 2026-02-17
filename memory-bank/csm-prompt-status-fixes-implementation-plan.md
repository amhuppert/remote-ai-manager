# CSM Prompt & Status Update Fixes — Implementation Plan

## Overview

Five interconnected issues prevent CSM from functioning correctly after sending prompts. The root cause is environment variable leakage into the spawned `claude -p` process, which causes it to hang. Secondary issues are missing UI refresh logic and stale status display. All fixes touch 3 files.

## Files Changed

| File | Change |
|---|---|
| `src/lib/prompt.ts` | Filter Claude env vars from child process |
| `src/app/projects/[name]/[session]/SessionDetailPage.tsx` | Add refresh, polling, optimistic status, error display |
| `src/app/globals.css` | Add `.prompt-error` styles |

## Implementation Steps

### Step 1: Fix `claude -p` environment (prompt.ts)

**Problem**: `...process.env` leaks `CLAUDE_CODE_SSE_PORT` and other `CLAUDE*` vars into the child process, causing it to hang indefinitely.

**Change**: In `executePrompt()`, replace lines 61–64:

```ts
// Before
env: {
  ...process.env,
  // Ensure Claude doesn't try to open a browser or ask for input
  CI: "1",
},
```

```ts
// After
env: {
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("CLAUDE"),
    ),
  ),
  CI: "1",
},
```

This filters out `CLAUDECODE`, `CLAUDE_CODE_SSE_PORT`, and any future `CLAUDE*` variables while preserving the rest of the user's shell environment (PATH, HOME, locale, etc.).

### Step 2: Update test for env filtering (prompt.test.ts)

**Update existing test** "sets CI environment variable to '1'" (line 251) to also verify that `CLAUDE*` vars are excluded.

Add a new test after it:

```ts
it("filters out CLAUDE-prefixed environment variables", async () => {
  // Temporarily set a CLAUDE_ env var on process.env
  process.env.CLAUDE_CODE_SSE_PORT = "12345";
  process.env.CLAUDECODE = "true";
  try {
    mockExecFileSuccess();
    await executePrompt("/projects/repo", makeSession(), "test");

    const cliCall = execFileMock.mock.calls[0]!;
    const opts = cliCall[2] as { env: Record<string, string> };
    expect(opts.env.CLAUDE_CODE_SSE_PORT).toBeUndefined();
    expect(opts.env.CLAUDECODE).toBeUndefined();
    expect(opts.env.CI).toBe("1");
  } finally {
    delete process.env.CLAUDE_CODE_SSE_PORT;
    delete process.env.CLAUDECODE;
  }
});
```

### Step 3: Add state and polling to SessionDetailPage.tsx

All remaining changes are in `SessionDetailPage.tsx`.

#### 3a. Add `promptError` state

After line 48 (`const [infoExpanded, setInfoExpanded] = useState(false);`), add:

```ts
const [promptError, setPromptError] = useState<string | null>(null);
```

#### 3b. Add polling useEffect

After the layout restore `useEffect` (after line 120), add:

```ts
// Auto-refresh while session is active (sending or server-side running)
useEffect(() => {
  if (!sending && session.status !== "running") return;

  const interval = setInterval(() => {
    router.refresh();
  }, 3000);

  return () => clearInterval(interval);
}, [sending, session.status, router]);
```

This polls every 3 seconds when:
- The client is waiting for a prompt response (`sending === true`)
- The server reports the session is running (covers page load during active prompt)

Polling stops automatically when both conditions clear, because `router.refresh()` re-runs the server component and passes fresh `session.status` props.

#### 3c. Rewrite `handleSendPrompt`

Replace lines 130–153 with:

```ts
const handleSendPrompt = useCallback(async () => {
  if (!promptText.trim() || sending) return;
  setSending(true);
  setPromptError(null);

  try {
    const res = await tracedFetch(
      `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(session.sessionName)}/prompt`,
      "send-prompt",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: promptText.trim() }),
      },
    );

    if (res.ok) {
      setPromptText("");
    } else {
      const data = await res.json().catch(() => ({ error: "Prompt failed" }));
      setPromptError(data.error || "Prompt failed");
    }
  } catch {
    setPromptError("Failed to send prompt");
  } finally {
    setSending(false);
    router.refresh();
  }
}, [promptText, sending, projectName, session.sessionName, router]);
```

Changes from original:
- Clears `promptError` at start
- Parses and sets error on non-ok response
- Sets error on network failure (was `// TODO: show error`)
- Calls `router.refresh()` in `finally` block
- Adds `router` to dependency array

#### 3d. Use optimistic status display

Replace lines 170–176:

```ts
// Before
const decodedProjectName = decodeURIComponent(projectName);
const statusDotClass =
  session.status === "running"
    ? "cyan"
    : session.status === "ready"
      ? ""
      : "";
```

```ts
// After
const decodedProjectName = decodeURIComponent(projectName);
const displayStatus = sending ? "running" : session.status;
const statusDotClass = displayStatus === "running" ? "cyan" : "";
```

Then update all JSX references to use `displayStatus`:

- **Line 198** (`{session.status}`) → `{displayStatus}`
- **Line 302** (`{session.status === "running" && (`) → `{displayStatus === "running" && (`

Also update the info strip status dot on line 234:

```ts
// Before
<span className={`status-dot ${statusDotClass}`} style={{ width: 6, height: 6 }} />
```

No change needed here — `statusDotClass` already uses `displayStatus` via the updated computation.

#### 3e. Add error display in conversation panel

After the running indicator (after line 307, after the closing `)}` of the running-indicator block), add:

```tsx
{promptError && (
  <div className="prompt-error">
    <span>{promptError}</span>
    <button onClick={() => setPromptError(null)}>&times;</button>
  </div>
)}
```

### Step 4: Add error CSS (globals.css)

After the `.running-indicator` block (after line 1265), add:

```css
.prompt-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-sm);
  padding: var(--space-sm) var(--space-md);
  background: var(--red-glow);
  border: 1px solid rgba(255, 61, 90, 0.3);
  border-radius: var(--radius-md);
  margin-bottom: var(--space-md);
  font-family: var(--font-mono);
  font-size: 0.78rem;
  color: var(--red);
  animation: fadeIn 0.3s ease;
}

.prompt-error button {
  background: none;
  border: none;
  color: var(--red);
  cursor: pointer;
  font-size: 1.1rem;
  padding: 0 var(--space-xs);
  opacity: 0.7;
}

.prompt-error button:hover {
  opacity: 1;
}
```

Uses existing design tokens (`--red`, `--red-glow`, `--radius-md`, `--font-mono`) and mirrors the `.running-indicator` pattern.

## Testing

### Automated

Run existing tests to verify no regressions, plus the new env filtering test:

```bash
npx vitest run src/lib/prompt.test.ts
```

### Manual verification

1. Start the dev server (ensure it has `CLAUDE_CODE_SSE_PORT` or other `CLAUDE*` vars in its environment — e.g., start it from within a Claude Code session)
2. Create a new session for any project
3. Send a simple prompt (e.g., "Say hello")
4. Verify:
   - Status immediately shows "running" (cyan dot) without manual refresh
   - The prompt completes (no 5-minute timeout)
   - UI auto-refreshes every 3 seconds during execution
   - After completion, status returns to "ready" and transcript messages appear
   - Hook events in logs show the worktree CWD (not the parent repo CWD)
5. Send a prompt that will fail (e.g., to a session with an invalid worktree path)
6. Verify the error banner appears with a dismissible message

## Edge Cases

- **Page load during active prompt**: If user navigates to a session that's already running, `session.status === "running"` from server props triggers polling automatically.
- **Rapid re-sends**: The `sending` guard and server-side lock prevent concurrent prompts. The 409 response is now displayed as an error banner.
- **Hook timing**: Hooks fire during `claude -p` execution. By the time the prompt API returns and `router.refresh()` runs, hook data (`claudeSessionId`, `transcriptPath`) should already be persisted in `state.json`.
