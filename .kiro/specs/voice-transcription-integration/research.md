# Research & Design Decisions

## Summary
- **Feature**: `voice-transcription-integration`
- **Discovery Scope**: Extension
- **Key Findings**:
  - Voice2Text already has full transcription/cleanup pipeline — only needs HTTP wrapper and config parameterization
  - CC has established patterns (withTracing, API routes, resolveProjectPath) that voice integration follows directly
  - Zero new npm dependencies in either project (Bun.serve() for V2T, native MediaRecorder for browser)
  - CleanupService already accepts `priorOutput` parameter with file-mode prompt template — context-aware transcription requires only data plumbing through the 4-layer chain

## Research Log

### Voice2Text Architecture
- **Context**: Need to understand existing V2T internals to design minimal-surface-area HTTP extension
- **Sources Consulted**: Direct codebase analysis of `/home/alex/github/my-ai-resources/voice-to-text/src/`
- **Findings**:
  - CLI flow: main.ts → hotkey listener → audio-recorder → transcriber (OpenAI gpt-4o-transcribe) → cleanup (Claude CLI subprocess) → clipboard/file output
  - Config resolution (`utils/config.ts`): 4-layer merge (global → local → specified → CLI). `loadLocalConfig()` hardcodes `process.cwd()`. `resolveConfig()` accepts `{ configPath?, cliOpts }` but has no `projectDir` parameter
  - Transcriber (`services/transcriber.ts`): Hardcodes `new File([buf], "audio.wav", { type: "audio/wav" })` — needs extension-based MIME derivation
  - Cleanup (`services/cleanup.ts`): Spawns `claude -p <prompt> --tools "" --system-prompt <...>` with 60s timeout. Falls back to raw text on any error
  - `readContextFilesContent()` is defined inline in `main.ts` (lines ~100-130) — needs extraction to shared util for server reuse
  - Bun runtime with `Bun.serve()` built-in HTTP server (zero deps)
  - Commander.js already supports subcommands
- **Implications**:
  - Config: Add `projectDir` param to `loadLocalConfig()` and `resolveConfig()` — backward compatible (defaults to undefined/cwd)
  - Transcriber: Replace hardcoded MIME with extension→MIME map — backward compatible (wav default)
  - Server: New `server.ts` reuses existing Transcriber + CleanupService instances. Extract `readContextFilesContent()` to `utils/context.ts`
  - Main: Add `serve` subcommand via Commander `.command("serve")`

### CC Integration Points
- **Context**: Need to map voice integration onto existing CC patterns
- **Sources Consulted**: Direct codebase analysis of session detail page, API routes, project resolver
- **Findings**:
  - `resolveProjectPath(name)` in `src/lib/project-resolver.ts`: async, returns `string | null`. Already used by all project-scoped API routes
  - `withTracing` wrapper from `@/lib/logging`: standard for all API routes. Extracts trace headers, logs request lifecycle
  - API error pattern: `NextResponse.json({ error: message } satisfies ApiError, { status: NNN })`
  - `SessionDetailPage.tsx` Props: `{ projectName, session, messages, diff }` — no `projectPath` yet
  - Server component (`page.tsx` line 20) already resolves `projectPath` but doesn't pass it through
  - Prompt area: `.prompt-input-wrapper` is flex with `gap: var(--space-sm)`, contains textarea + send-btn (48x48px)
  - `promptError` state + dismissable banner already exists for error display
  - `sending` state already drives button disabled state
  - `src/hooks/` directory does not exist — must be created
  - `src/components/` has 4 shared components, each with colocated `.test.tsx`
- **Implications**:
  - Voice API routes follow identical pattern to existing prompt route
  - VoiceRecordButton matches send-btn sizing (48x48) and sits beside it in the flex wrapper
  - Error handling reuses existing `setPromptError` mechanism
  - New `src/hooks/` directory for `useVoiceRecorder.ts`

### Browser Audio Recording APIs
- **Context**: Verify MediaRecorder API capabilities for voice capture
- **Sources Consulted**: MDN Web Docs, browser compatibility tables
- **Findings**:
  - `MediaRecorder` API widely supported (Chrome, Firefox, Safari 14.1+, Edge)
  - `audio/webm;codecs=opus` preferred for Chrome/Edge/Firefox; Safari may need fallback
  - `MediaRecorder.isTypeSupported()` used for format negotiation
  - `getUserMedia({ audio: true })` requires HTTPS or localhost (CC accessed via Tailscale uses HTTPS)
  - `dataavailable` event fires chunks; `stop` event signals end
  - OpenAI accepts webm natively — no client-side conversion needed
- **Implications**:
  - Three-tier MIME negotiation: `audio/webm;codecs=opus` → `audio/webm` → browser default
  - No audio conversion step needed — browser webm sent directly through proxy to OpenAI

### Context-Aware Transcription Discovery (Requirement 10)
- **Context**: Need to pass existing input text through the entire chain (hook → CC API → V2T server → cleanup) so transcription is formatted to continue from existing content
- **Sources Consulted**: Direct analysis of `cleanup.ts`, `server.ts`, `useVoiceRecorder.ts`, `transcribe/route.ts`, `SessionDetailPage.tsx`, `CreateSessionModal.tsx`
- **Findings**:
  - CleanupService already accepts optional `priorOutput` parameter (cleanup.ts line 16)
  - File-mode cleanup prompt template (`FILE_MODE_CLEANUP_PROMPT_TEMPLATE`) already exists with `{PRIOR_OUTPUT}` placeholder (cleanup.ts line 144)
  - File-mode cleanup system prompt includes continuation-aware instructions: "continue naturally from the prior document content" (cleanup.ts line 137)
  - V2T server currently calls `cleanupService.cleanup(transcription, contextFiles, instructionsFiles)` without `priorOutput` — the fourth argument is omitted (server.ts line 144)
  - CC useVoiceRecorder builds FormData with only `audio` and `projectName` — no context field (useVoiceRecorder.ts line 173-177)
  - CC transcribe route forwards only `audio` and `projectPath` — no context forwarding (route.ts line 48-50)
  - Both SessionDetailPage and CreateSessionModal use `useVoiceRecorder` and have access to their current input text state (`promptText` / `objective`)
- **Implications**:
  - The cleanup infrastructure for context-aware formatting is fully built; only data plumbing is needed
  - All 4 layers need a single optional field added — no new prompt templates or cleanup logic
  - Using a `getContext` callback (rather than a static value or ref) ensures the latest text is captured at FormData build time
  - The `getContext` approach keeps the hook generic — callers decide what constitutes "existing context"

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Direct browser→V2T | Browser calls V2T server directly | Simpler, fewer hops | V2T binds localhost only; breaks remote/Tailscale access | Rejected |
| CC proxy | Browser→CC API→V2T | Works remotely, centralized auth point | Extra hop adds latency | Selected — matches CC's role as control plane |
| WebSocket streaming | Stream audio chunks in real-time | Lower latency start | Complexity, V2T not designed for streaming | Deferred — batch is sufficient for dictation |

## Design Decisions

### Decision: CC Proxy Architecture
- **Context**: V2T server binds to localhost; CC may be accessed remotely via Tailscale
- **Alternatives Considered**:
  1. Direct browser→V2T — breaks remote access
  2. CC API proxy — adds hop but enables remote
  3. CC WebSocket relay — streaming complexity not justified
- **Selected Approach**: CC API proxy route forwards multipart form data to V2T
- **Rationale**: CC already serves as the control plane; voice is another resource it proxies. Pattern matches existing API routes
- **Trade-offs**: +Remote access, +Centralized error handling; −Extra network hop (negligible for audio dictation)
- **Follow-up**: Monitor transcription latency in production

### Decision: No New Dependencies
- **Context**: Both projects aim for minimal dependency footprint
- **Selected Approach**: Bun.serve() for V2T server, native MediaRecorder for browser audio, native fetch for CC proxy
- **Rationale**: Bun.serve() is zero-config HTTP server. MediaRecorder is well-supported. No form parsing library needed (Bun FormData is built-in)
- **Trade-offs**: +No dependency management; −Bun.serve() less featureful than Express (acceptable for 2 routes)

### Decision: Health-Gated Voice Button
- **Context**: Voice server is optional; should not break UI when down
- **Selected Approach**: Voice button renders only when health check returns available. Periodic re-check every 30s
- **Rationale**: Graceful degradation — UI remains clean when voice is unavailable. Re-check enables button to appear/disappear dynamically
- **Trade-offs**: +Clean UX when voice unavailable; −30s delay for button to appear after V2T starts

### Decision: getContext Callback for Input Text Passing
- **Context**: Need to pass existing text from the input field to V2T for context-aware cleanup
- **Alternatives Considered**:
  1. Pass text as a static `context` option prop — stale if text changes between recording start and stop
  2. Pass a ref to the input text — works but couples hook to React ref semantics
  3. Pass a `getContext` callback — called at FormData build time, always captures latest value
- **Selected Approach**: `getContext?: () => string` callback in `UseVoiceRecorderOptions`
- **Rationale**: Called at submission time (after recording stops) so it captures the text that was in the field when the user stopped recording. Keeps the hook generic — any caller can provide any context source
- **Trade-offs**: +Always fresh value, +Generic API; −Caller must provide stable callback (wrap in useCallback)
- **Follow-up**: Ensure both SessionDetailPage and CreateSessionModal provide memoized getContext callbacks

### Decision: Reuse File-Mode Cleanup for Context
- **Context**: V2T cleanup has two prompt paths — standard and file-mode (with priorOutput). Need to decide how to handle input text context
- **Alternatives Considered**:
  1. Create a third prompt template specific to "input context" mode
  2. Reuse the existing file-mode template and `priorOutput` parameter
- **Selected Approach**: Reuse file-mode cleanup by mapping `context` → `priorOutput`
- **Rationale**: The file-mode template is already designed for continuation-style cleanup with instructions like "continue naturally from the prior document content" and "output ONLY the new text to append". This is exactly the behavior needed when there's existing text in the input
- **Trade-offs**: +Zero new prompt engineering, +Proven template; −File-mode label is slightly misleading (it's not a file), but this is internal and not user-facing

## Risks & Mitigations
- **V2T server not running** — Health-gated button hides feature entirely; no broken state
- **Microphone permission denied** — Clear error message via existing promptError display
- **Long transcription (>60s)** — AbortSignal timeout at CC proxy; user sees timeout error
- **Claude cleanup failure** — V2T falls back to raw transcription (existing behavior)
- **Browser MIME type incompatibility** — Three-tier fallback chain for MediaRecorder format

## References
- [OpenAI Audio Transcription API](https://platform.openai.com/docs/guides/speech-to-text) — Supported formats: mp3, mp4, mpeg, mpga, m4a, wav, webm
- [MDN MediaRecorder API](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder) — Browser audio recording
- [Bun.serve() Documentation](https://bun.sh/docs/api/http) — Built-in HTTP server
