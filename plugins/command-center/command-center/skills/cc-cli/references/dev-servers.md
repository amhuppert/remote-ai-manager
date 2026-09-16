## cctl dev

Manage this session's **dev servers** — the app processes CC spawns per worktree
(ports, local/remote URLs, liveness).

A configured dev server runs the target project's application. Use the URLs
returned for this session; browser tools do not infer which worktree owns a port.

When the project being developed is Command Center itself, its dev server is a
**second CC instance** with its own database, token, logs, and published `cctl`.
Bare CLI commands still target the managing instance. Use `cctl dev doctor` and
the fixture commands below when verifying CC's own durable state. These
CC-specific diagnostics do not apply to an ordinary project's web server.

```
cctl dev list [--json]
cctl dev ensure [<serverName>]
cctl dev stop <serverName>
cctl dev doctor [<serverName>]
```

- `list` — show every configured server with its status and the `local`/`remote`
  URLs (the fields you actually need). With `--json`, each entry carries a derived
  `localUrl`. When nothing is configured it prints a plain notice.
- `ensure` — start (or adopt) a server and **block until it is live** or a bounded
  timeout elapses, then print its resolved URLs. Omit `<serverName>` when the
  project configures exactly one server; pass a name to disambiguate — an
  ambiguous omission exits `2` and lists the names. If the project configures no
  dev servers it exits `1` pointing you at `CommandCenter.json`; a start failure
  exits `1` with the server's recent output. On success it hints the local URL to
  drive and how to re-check liveness.
- `stop` — stop a named server (ownership-verified, so externally owned listeners
  are never killed). Terminal — **no hint**.
- `doctor` — report the managing server and this session's dev server **side by
  side**: build stamp, the state directory each owns, and the `cctl` each
  publishes, plus which one a bare `cctl` verb reaches. Run it whenever something
  you created through the CLI does not show up in the dev server — differing
  `config dir` values mean two databases. It resolves the dev server and
  authenticates with *that server's* token, which is why the hand-rolled
  `cctl doctor --server <devUrl>` exits `3`: every instance mints its own token
  and the ambient `CC_API_TOKEN` belongs to the managing one. The registry read
  states no build, so it still answers when your binary is skewed against either
  instance.

Always run `cctl dev ensure` **before** driving Playwright, browser, visual, or
Next.js tools — never assume ports like 3000 or 6006 belong to your worktree;
parallel sessions run on different ports.

```
cctl dev ensure
# → web — running
#     local:  http://localhost:5010
#     remote: https://web.example.ts.net
#   hint: drive the app at http://localhost:5010; re-check liveness with 'cctl dev list'
```

## cctl fixture

For development of Command Center itself, scaffold **live-test state** —
throwaway sessions and real LLM turns — to verify CC features in its dev instance. Every verb targets the session's
**worktree dev server** (auto-resolved through `cctl dev`'s registry), never
the managing CC instance: fixtures create and delete real sessions, and an
explicit `--target` equal to the managing server is refused.

This is the one command family that addresses **two** CC instances, and the only
one exempt from the build-parity gate: the dev server runs your branch while your
binary comes from whichever server published it, so the two builds differ by
construction and any stamp would be refused by one hop or the other. fixture
therefore states no build and works from **any** `cctl` — including one skewed
against both servers. It is also how you produce **server-owned state inside the
dev server**: prompt an agent in a fixture session and its own `CC_SERVER_URL`
and `CC_API_TOKEN` point at that instance, so the verbs it runs land there.

```
cctl fixture session create <project> [--name <n>] [--dev <serverName>] [--target <url>] [--skip-warm]
cctl fixture session delete <project> <sessionName>
cctl fixture prompt <project> <sessionName> --text "<prompt>" [--conversation <id>] [--wait [--timeout <sec>]]
cctl fixture status <project> <sessionName>
```

- `<project>` is the project **on the dev server** (use a scratch project set
  aside for testing). An unknown name exits `2` listing the projects the dev
  server actually has.
- `session create` — creates the session and returns everything a live test
  needs in one envelope: `sessionName`, a ready `conversationId`, deep-link
  `urls` (session page + `/conversations?c=<id>`), and the dev instance's
  `dbPath`/`transcriptPath` for backend verification. It also **pre-warms**
  the returned routes (dev mode compiles each route on first hit, ~5–10s), so
  the first browser navigation lands warm; `--skip-warm` opts out.
- `session delete` — tears the session down (encodes the
  `DELETE …/sessions?sessionName=` query-param contract so you never have to).
- `prompt` — runs a **real LLM turn** in the conversation (defaults to the
  session's only conversation; pass `--conversation` when there are several).
  With `--wait` it blocks by reading the prompt SSE stream until the server's
  `done`/`error` event — no hand-rolled status polling; `--timeout <sec>` caps
  the wait (the turn keeps running server-side on timeout). Without `--wait`
  it returns immediately with `turn: "started"`.
- `status` — one-shot list of the session's conversations with their `status`
  (`new | awaiting | running | waiting_for_input`; a finished turn settles at
  `awaiting`).
- `--dev <serverName>` disambiguates when several dev servers are running.

```
cctl dev ensure
cctl fixture session create scratch-project --json
# → {"ok":true,"sessionName":"fx-...","conversationId":"...","urls":{...},"transcriptPath":"..."}
cctl fixture prompt scratch-project fx-... --text "reply with exactly: marker-7" --wait --json
rg "marker-7" <transcriptPath>   # verify against durable state, not the UI
cctl fixture session delete scratch-project fx-...
```
