---
name: playwright-cli
description: Automate a browser with playwright-cli for interactions, visual
  checks, debugging, or Playwright test authoring.
---

# Browser automation with playwright-cli

For this project's app or Storybook, run `cctl dev ensure <server>` first and use the session URL it returns. Use one named browser session per task, including the session flag on subsequent calls; this keeps parallel agents' browsers separate.

```bash
playwright-cli -s=<task> open <session-url>
playwright-cli -s=<task> snapshot
playwright-cli -s=<task> click e15
playwright-cli -s=<task> screenshot --filename=.cc/temp/after.png
playwright-cli -s=<task> close
```

Snapshot refs such as `e15` come from the current page snapshot. Refresh them after DOM changes when needed. Role/test-id locators can express stable intent; inspect the actual element before choosing one.

## Command discovery and output

Use `playwright-cli --help` and `playwright-cli --help <command>` for the installed syntax. CLI capabilities vary by version; help owns the command catalog.

- `--raw` returns only the result, useful for JSON piping or a bounded state probe.
- `--json` wraps the reply as structured output.
- `snapshot <target>` scopes an accessibility snapshot; `--filename` gives the artifact a stable path.
- `eval` accepts a JavaScript expression or function; `run-code` accepts a single Playwright function expression and supports `--filename` for code with complex quoting.
- `requests` lists network calls and `request <index>` opens one; `console` reads client messages.

Snapshots and small evaluation results are useful for structure/state. Capture and open screenshots when judging appearance; exercise actual input behavior when judging interaction. A screenshot or optimistic UI alone cannot prove a backend write persisted.

Wait for a locator or an observable state through `run-code`. CC uses persistent SSE, so `networkidle` is not a readiness criterion.

## Sessions and installation

Close or delete only sessions/data created for this task. `close-all` and `kill-all` affect other work and require explicit authorization for that wider scope. Attach to an existing personal browser/profile only when the request calls for it; detach after the task rather than closing the user's browser.

If the command is absent, check the repository's installed executable. A package runner can invoke `@playwright/cli` without a global installation; read its help before proceeding. Browser automation alone does not authorize installing a project test scaffold or changing unrelated configuration.

Use the harness's tracked background execution for a paused test or debugger that must remain running, then stop that task when finished. Do not detach it to outlive session tracking.

## Reference routing

Read only the branch needed for the task:

| Task | Reference |
|---|---|
| Run/debug existing Playwright tests | [playwright-tests.md](references/playwright-tests.md) |
| Author or repair behavior tests from a test plan | [spec-driven-testing.md](references/spec-driven-testing.md) |
| Turn recorded actions into assertions | [test-generation.md](references/test-generation.md) |
| Complex waits, frames, media, or evaluation | [running-code.md](references/running-code.md) |
| Named sessions, attach, and persistent profiles | [session-management.md](references/session-management.md) |
| Mock requests for an explicitly scoped test | [request-mocking.md](references/request-mocking.md) |
| Cookies and local/session storage | [storage-state.md](references/storage-state.md) |
| Diagnose a flow with a trace | [tracing.md](references/tracing.md) |
| Record a demonstration | [video-recording.md](references/video-recording.md) |
| Inspect attributes absent from a snapshot | [element-attributes.md](references/element-attributes.md) |

Finish when the requested flow has been exercised with appropriate evidence. Report the outcome, artifacts, and any unverified behavior.
