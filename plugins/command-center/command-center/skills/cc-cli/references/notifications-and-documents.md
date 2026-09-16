## cctl notify

Send a push notification to the user (e.g. a long task finished, or you need
attention).

```
cctl notify "<message>" [--title "<title>"]
```

- The message is the single positional argument — quote multi-word messages.
- `--title` sets the notification title; it defaults to a generic title when
  omitted.
- Exit `0` on delivery. If push notifications are unconfigured or disabled the
  command exits `1` with a one-line reason — treat that as **non-fatal**; it
  just means the user will not be paged.
- A notification is terminal: there is no follow-up command, so `notify`
  deliberately prints **no hint**.

```
cctl notify "Build finished — 0 failures" --title "CI"
```

## cctl docs

Manage this session's **reference documents** — files other conversations see
in their system prompt, with a note on when to read them.

```
cctl docs register <path> --description "<why it matters>"
cctl docs list [--json]
cctl docs delete <id>
```

- `register` — register (or update) a document. `<path>` is a single positional
  (quote paths with spaces); `--description` is required and explains when/why
  agents should read it. The path must resolve **inside the session worktree** —
  an escaping path exits `2`. Re-registering the same path is idempotent: it
  updates the description in place rather than creating a duplicate. Terminal —
  **no hint**.
- `list` — print every registered document (`id  path  —  description`). Ends
  with a hint pointing at `register`/`delete`. With `--json`, the documents are
  in the `documents` array and the hint is in the reserved `hint` field.
- `delete` — deregister by `<id>` (from `list`) and remove the file from disk.
  An unknown id exits `2`. Terminal — **no hint**.

```
cctl docs register docs/api-contract.md --description "read before touching any /api route"
cctl docs list
cctl docs delete 4f1d2797-...
```
