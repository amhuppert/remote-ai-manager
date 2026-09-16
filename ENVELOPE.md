# Operating envelope

Command Center is run by one person, Alex, on two machines: a Mac and a Linux box. Each machine runs its own CC server with its own state, and the two never share, sync, or talk to each other. On each, Alex drives it from a browser on the laptop and a phone over a private Tailscale network, through the `cctl` CLI, and through Claude, Codex, and Cursor agents acting on Alex's behalf inside git worktrees. A failure costs Alex's time, worktree state, and API spend; nobody else is affected.

Nearest archetype: single-operator tool, daemon variant. It departs from that archetype in three ways. One always-on server coordinates many concurrent agent sessions, workflows, and child processes. Several CC processes can share one machine: a production build runs beside the live server on the same database, and a per-session dev server is a separate CC instance with its own database. Agents are trusted. Per-lane and per-worktree restrictions exist so that concurrent agents do not clobber each other's work; they are coordination, not a security boundary. What agents and models produce is still parsed strictly, because model output is unreliable data, not because it is hostile.

| Dimension | Condition |
|---|---|
| Users | Alex alone, at a laptop browser, a phone on the tailnet, a terminal, and through agents driving `cctl`. Alex and those agents are the only readers of logs and errors. |
| Trust | Callers trusted, agents included. The browser is ungated, and the API token selects a CC instance rather than authenticating anyone. Lane, conversation, and worktree restrictions are coordination against clobbering, not a defense against a hostile agent. Hostile or unreliable data: provider streams, third-party MCP servers, content agents fetch from outside, and model output, which is parsed strictly because it is unreliable. |
| Concurrency | Many agent sessions, lanes, and workflows in one server process against one SQLite file and shared git worktrees. Several processes on that SQLite file during a production build beside the live server, or when an older branch opens it. Two devices of one user, or an agent and Alex, may write between two steps of one caller. |
| Topology | One machine at a time, macOS or Linux, each with an independent CC instance. One Next.js server plus child processes: a Claude CLI per conversation, a Codex process per turn, a Cursor worker per conversation, dev servers, validation process groups, MCP probes, a local voice server. A per-session dev server is a second CC instance with its own database and config directory. Outbound calls cross the network to Anthropic, OpenAI, and Cursor. The only crossing between the two machines' states is an exported ticket bundle carried by hand. |
| Lifetime | An always-on daemon restarted by rebuilds while conversations and workflows are mid-flight. SQLite state and the config directory outlive every build and are migrated, never recreated (assumed). Worktrees are short-lived. |
| Failure cost | Alex's time, worktree and git state, persisted history, and API spend. No one else's data; no one is paged. |
| Compatibility | Its own SQLite rows, JSON files, and config across rapid builds; the installed `cctl` versus the server that published it; Alex's other projects that install the cctl plugin (assumed sole consumer); two host OSes with their own config-dir conventions, process tools, and native SDK builds; three agent runtimes with different skill loaders; vendor SDKs, Claude and Codex config files, and the Kiro layout, which change on their owners' schedules. |
| Scale | One person's data. The binding limits are the LLM context window, host RAM for concurrent child processes, and transcripts in the low thousands of entries (assumed). |

## Outside the envelope

- Other human users: logins, roles, sessions, tenants.
- Hostile callers: the server is reachable only on loopback and the tailnet; Tailscale Funnel or any public exposure is out.
- Agents as adversaries: forged lane or conversation identities, replayed credentials, or a hostile local process holding the API token. A mistaken agent is in scope; a malicious one is not.
- Two CC instances sharing state, syncing, or calling each other across machines; each installation is self-contained.
- A second server process driving the same database concurrently with the live server, beyond build workers and older-branch checks.
- Windows or CI hosts.
- Consumers of the HTTP API or CLI output outside this repository and Alex's own projects: API versioning, deprecation cycles, wire shims for retired shapes.
- Retries with backoff around local calls; circuit breakers, health endpoints, metrics exporters, tracing to an external system.
- Horizontal scale, sharding, request-rate caches, feature flags, i18n.
- An enterprise-managed host overriding agent SDK settings.
