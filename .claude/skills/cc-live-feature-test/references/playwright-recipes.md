# playwright-cli Recipes & Gotchas for CC

Every claim here was verified live against a CC dev server. Pair with `routes-and-api.md` for URLs and fixture contracts.

## The known-good verification shape (use this by default)

1. **Seed via API/`cctl fixture`, not by click-driving** — create the session/conversation over REST, get the ids from the response.
2. **Deep-link straight to the target** (`/conversations?c=<id>`, `/projects/<p>/<s>`) — never navigate by clicking through pages.
3. **Assert with one-line `eval` probes returning tiny strings**, not by reading snapshots:
   ```bash
   playwright-cli -s=<name> eval "(() => { const rows = document.querySelectorAll('[data-testid=\"message-row\"]'); return rows.length + ' messages'; })()" --raw
   ```
4. **Verify against backend state** (transcript JSONL, SQLite, API responses) — the UI is optimistic and lies.
5. Clean up: delete fixture sessions, `playwright-cli -s=<name> close`.

A tight verification round is ~7 browser calls: open → goto → 3–4 eval probes → screenshot (optional, for visual review) → close.

## Waiting (dev mode makes this mandatory)

**Expect the first visit to any route to take 5–10s** in dev: Next compiles the page route (~5–6.5s) *and* each API route on demand (0.4–1.7s each). Warm loads are <600ms. This is not a bug; do not investigate unless a *warm* load stalls >30s.

The wait idiom — `run-code` gives the full Playwright API:

```bash
# wait for text to appear
playwright-cli -s=x run-code "async page => await page.getByText('some text').waitFor({timeout: 30000})"
# wait for a loading state to clear
playwright-cli -s=x run-code "async page => await page.getByText('Loading conversations').waitFor({state: 'hidden', timeout: 30000})"
# navigate + wait in one call, returning elapsed time
playwright-cli -s=x run-code "async page => { const t=Date.now(); await page.goto('<url>'); await page.getByTestId('conversation-list').waitFor({timeout: 30000}); return Date.now()-t; }" --raw
```

- **Never use `waitForLoadState('networkidle')`** — CC pages hold a persistent SSE connection, so the network never goes idle; it will always time out.
- Don't hand-roll shell poll loops. If you must, **never name a zsh variable `status`** (read-only reserved; kills the loop).

## Snapshots — one step, scoped, named

```bash
# WRONG (3 steps, truncation risk): snapshot → ls -t .playwright-cli → grep
# RIGHT (1 step): named file + immediate grep
playwright-cli -s=x snapshot --filename=after-click.yml && grep -n "chip" after-click.yml
# Better: scope to an element — ~10 lines instead of ~170 for a full page
playwright-cli -s=x snapshot "#composer" --filename=composer.yml
```

- `--filename=` writes to the **CWD** (both `snapshot` and `screenshot`); auto-named outputs go to `.playwright-cli/`.
- Prefer element-scoped snapshots over `--depth=N` — depth truncation hides content and produces false "not found".

## `eval` gotchas

- The argument must be an **expression**. Bare statements throw `SyntaxError: Unexpected token 'const'`. Wrap in an IIFE:
  ```bash
  playwright-cli -s=x eval "(() => { const n = document.querySelectorAll('a').length; return 'links: ' + n; })()" --raw
  ```
- Return **small strings/numbers**, not DOM dumps — the probe result lands in your context.
- Clipboard + synthetic paste work via eval: `navigator.clipboard.readText()`, `new ClipboardEvent('paste', {clipboardData})`.

## Selectors

- `:has-text()` matches only the element type you name — `li:has-text('foo')` finds nothing when rows are `<div>`s. Check the real tag in a snapshot first, or use `getByText(...)`/`getByRole(...)`/`getByTestId(...)` which don't care about tags.
- Prefer `data-testid` where present (see the testid table in `routes-and-api.md` as they're added).

## Session hygiene

- One named browser session per task, reused across rounds: `playwright-cli -s=<task> open --browser=chrome <url>`.
- `cctl dev ensure <server>` first, drive `localUrl` — ports are per-worktree.
- Close when done: `playwright-cli -s=<task> close`.
