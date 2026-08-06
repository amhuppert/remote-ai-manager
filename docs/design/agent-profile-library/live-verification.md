# Live Verification — Agent profile library, conversation profiles (2026-08-02)

Live real-provider proof for `agent-profile-library/R9.6`: a conversation created
with a **project-tier** profile demonstrably follows that profile's instructions
on a real provider, with the persisted snapshot as evidence.

This is the live half of the transport contract. The deterministic half — the
per-backend adapter assertions, the composer's hash coverage, and the
non-leakage matrix — lives in the unit suites and is not restated here.

- CC worktree: `.worktrees/…-e65782.context-agent-profile-library-task-conversation-persistence`
- Dev server: `http://localhost:3457`, `CC_CONFIG_DIR=<worktree>/.config` (worktree-local; **not** the production config dir)
- Scratch project: `qscratch` → `/tmp/ccp/qscratch`
- Production code exercised: `resolveConversationProfileSnapshot`, `buildAgentProfileSnapshot`, `composeProfileBlock`, `admitConversationProfileForTurn`, `resolveConversationProfileInjection`, `toPublicConversationState`, both backend conversation runtimes

## The profile under test

`project:quill-scribe` revision 1, created through
`POST /api/projects/qscratch/agent-profiles` (HTTP 201). Its instructions demand
an unmistakable behavioral marker — the sign-off token `ZORPTANGLE-7741` as the
final line of every reply. The token is arbitrary and appears nowhere else in
the system, so any occurrence in model output is attributable to the profile.

The create response was already the **redacted** listing projection: `ref`,
`name`, `description`, `revision`, `recommendedFor`, `tags`, `readOnly` — no
`instructions`.

---

## Scenario 1 — Claude (Opus 5): PASS

Created through the UI path: project cockpit → Conversations tab → the
`Agent profile` row above the composer. The picker defaulted to
`Standard Agent` badged `Built-in`, listed `Quill Scribe` under a `Project`
group, and sat beside — not merged into — the separate backend / model / effort
controls.

Conversation `f8192a67-a7ff-47e8-902d-4616ab2b2691`, prompt:

```
probe-4482: In one short sentence, what is the capital of France?
```

### 1. The marker appears in real model output

`.config/transcripts/f8192a67-a7ff-47e8-902d-4616ab2b2691.jsonl`, assistant record:

```json
{"type": "assistant", "role": "assistant",
 "content": [{"type": "text", "text": "Paris.\n\nZORPTANGLE-7741"}]}
```

Nothing in the prompt asked for a sign-off. The token is the profile's
instruction being followed by the provider.

### 2. The persisted snapshot carries both hashes and the rendered block

`project_conversations.profile_snapshot` holds all eight fields — `tier`, `id`,
`name`, `revision`, `sourceContentHash`, `instructions`,
`renderedInstructionBlock`, `resolvedInstructionHash`:

```
tier                     project
id                       quill-scribe
revision                 1
sourceContentHash        sha256:2b5f4e6f525c577b3563a4edd992eaf9fa3428a5a62a31f82ecdaad6c11a9c6d
resolvedInstructionHash  sha256:56f70a861f548d6d65f95c018d60a9553947a49edbe4a013fce0a05019b36083
profile_locked_at        2026-08-02T07:17:12.722Z
```

`renderedInstructionBlock` contains the five-level precedence contract, the
subordination paragraph, the provenance line
`Profile: Quill Scribe (project:quill-scribe, revision 1)`, and the
`<<<CC_AGENT_PROFILE_BEGIN>>>` / `<<<CC_AGENT_PROFILE_END>>>` delimiters.

Both hashes were recomputed independently of CC — SHA-256 over the
NFC-normalized UTF-8 of the stored block — and matched the persisted envelope
exactly. `sourceContentHash` equals the `sourceContentHash` on the library
record at `.config/agent-profiles/<scopeKey>/quill-scribe.json`.

`profile_locked_at` is stamped at creation, i.e. before the first provider
runtime existed.

### 3. The conversation header shows the profile identity

`ConversationProfileChip` in the cockpit's conversation header:

```
text        Quill Scribe · Project
data-tier   project
aria-label  Agent profile: Quill Scribe (Project)
```

### 4. The redacted projection carries no instruction text

Observed live during the run. Each surface carries only
`{tier, id, name, revision, sourceContentHash, resolvedInstructionHash}`:

| Surface | Instruction text |
|---|---|
| `GET /api/projects/qscratch/conversations` | absent |
| `POST /api/projects/qscratch/conversations` (201 body) | absent |
| `conversation-created` SSE frame on `/api/events` | absent |
| `conversation.profile_injected` log event | absent (redacted description only) |
| `GET …/conversations/<id>/messages` | absent |
| Rendered page text | absent |

Probes: `You are the Quill Scribe`, `CC_AGENT_PROFILE_BEGIN`,
`subordinate specialization lens`, `renderedInstructionBlock`, `"instructions"`.

The messages endpoint and the page do contain the string `ZORPTANGLE-7741`
exactly once each — inside the assistant's own reply, which is the proof of
adherence, not a leak of the instruction layer.

Instructions were reachable at exactly one place: the authorized single-profile
`GET /api/projects/qscratch/agent-profiles/project/quill-scribe`.

---

## Scenario 2 — Codex (gpt-5.4): transport proven, adherence not

Conversation `a89dae5d-4a91-4da0-b0ee-039283a6b473`, prompt
`probe-9917: In one short sentence, what is the capital of Japan?`.

The snapshot persisted identically (same ref, revision, and
`resolvedInstructionHash`), and `conversation.profile_injected` logged
`injected: true`.

**The block was delivered.** In Codex's own rollout
(`~/.codex/sessions/2026/08/02/rollout-…-019fc158-….jsonl`), the stored
`renderedInstructionBlock` is a **byte-for-byte substring** of the first turn's
prompt input, inside the fenced `## System Instructions` header, positioned last
among the session instructions — matching D20's documented Codex semantics and
the composer's "level 5, delivered after every CC-owned layer" ordering.

**The model did not follow it.** The reply was `Tokyo is the capital of Japan.`
with no sign-off token.

This is the weaker textual delivery D20 accepts explicitly rather than papers
over: on Codex the profile arrives as prose in the first user turn, not as a
provider-level system prompt. R9.6 requires the behavioral proof on *at least
one* backend, and Claude supplies it; recorded here so the difference is a known
property rather than a surprise.

---

## Defect found during this run

`scopeKey()` in `src/lib/agent-profiles/storage.ts` is
`base64url(projectPath)` used directly as a directory name. base64 expands 4/3,
so any project path longer than ~191 bytes yields a name over the 255-byte
filesystem limit and **every project-tier profile operation fails with
`ENAMETOOLONG` (HTTP 500)**. Observed on the first attempt with a project at a
233-character path:

```
ENAMETOOLONG: name too long, mkdir '…/.config/agent-profiles/L1VzZXJzL2FsZXgv…'
```

Global-tier profiles are unaffected (fixed key `global.shared`). The scenarios
above were run from a short project path to work around it. A digest-based or
truncated-plus-digest scope key would remove the length coupling; not fixed here
because it falls outside this task's scope.
