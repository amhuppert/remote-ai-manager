# Backend Capability Verification

Status: Kiro task 1 gates are represented in metadata, pure translators, runtime composition, and apply planning. Downstream UI/apply work must treat this matrix as authoritative until a later verification task changes it.

## Support Matrix

| Cascade | Discovery | Runtime emission | Apply status | Evidence |
|---|---|---|---|---|
| `claude-skills` | Available | Runtime-emittable via `Settings.skillOverrides` | `idle-live-apply` | `claude-runtime-translator.ts`, Claude SDK `Settings.skillOverrides` |
| `claude-plugins` | Available | Runtime-emittable via minimal `Settings.enabledPlugins` deltas | `idle-live-apply` | `claude-plugin-translator.ts`, Claude SDK `Settings.enabledPlugins` |
| `claude-agents` | Available | Runtime-emittable only at session creation through permission-layer Task denial | `next-conversation` | `claude-agent-suppression.ts`, Claude SDK `CanUseTool`, `TaskInput.subagent_type` |
| `codex-skills` | Available from files | Verification-gated, non-emittable | `unsupported` while gated | `codex-discovery.ts`, `codex-translator.ts`, Codex SDK `CodexOptions.config` has no verified per-skill key |
| `codex-plugins` | Unavailable pending verification | Verification-gated, non-emittable | `unsupported` while gated | `codex-discovery.ts`, `codex-translator.ts`, no authoritative installed/enabled plugin source verified |

## Codex Gate

Codex skill discovery is verified from these read-only sources:

- project `.agents/skills`
- project `.codex/skills`
- user `~/.agents/skills`
- user `~/.codex/skills`
- system `~/.codex/skills/.system`

`discoverCodexSkills()` returns normalized items and a content-sensitive `sourceSignature` built from item id, source, source path, parsed description, and argument hint. File read failures become diagnostics.

Runtime emission is not verified for either Codex cascade. The installed `@openai/codex-sdk` typings expose a generic `CodexOptions.config` pass-through, but no documented per-skill or per-plugin enablement key. `translateCodexCapabilities()` therefore emits `{}` and diagnostics instead of speculative config. `composeConversationStartRuntime()` does not seed runtime state for verification-gated Codex cascades, and `planCascadeApply()` reports `unsupported` for those cascades.

Downstream contexts must not show Codex skill/plugin toggles as runtime-applicable while `compositionSupport` remains `verification-gated`.

## Claude Agents

No typed per-agent disable map exists in the installed Claude SDK `Settings`. The verified suppression path is `Options.canUseTool`: intercept `Task`, read `input.subagent_type`, and deny when that agent is disabled by CC configuration.

This binding is created when the session starts, so `claude-agents` is `next-conversation`, not `idle-live-apply`. Plugin-contributed agents can still be removed indirectly by disabling the owning plugin and reloading plugins.

## Claude Plugins

`translateClaudePluginEnablement()` preserves native plugin settings by omission:

- no CC override: omit the plugin
- resolved state equals native state: omit the plugin
- CC disables natively enabled plugin: emit `false`
- CC enables natively disabled plugin: emit `true`
- stale plugin id: emit a diagnostic and no flag-layer value

The translator returns an in-memory SDK flag payload only. It does not write backend-owned settings files and never re-emits native extended plugin objects.

## Verification Commands

Focused and integration-adjacent tests run in this context:

```bash
bun run test:ai src/lib/agent-capabilities src/lib/agent-backends/claude/conversation-runtime.test.ts
bun run typecheck:ai
```

Result: 265 passing tests and typecheck passed.
