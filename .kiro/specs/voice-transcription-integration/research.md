# Research & Design Decisions

## Summary
- **Feature**: `voice-transcription-integration`
- **Discovery Scope**: Extension
- **Key Findings**:
  - Voice2Text already has full transcription/cleanup pipeline — only needs HTTP wrapper and config parameterization
  - CSM has established patterns (withTracing, API routes, resolveProjectPath) that voice integration follows directly
  - Zero new npm dependencies in either project (Bun.serve() for V2T, native MediaRecorder for browser)

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

### CSM Integration Points
- **Context**: Need to map voice integration onto existing CSM patterns
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
  - `getUserMedia({ audio: true })` requires HTTPS or localhost (CSM accessed via Tailscale uses HTTPS)
  - `dataavailable` event fires chunks; `stop` event signals end
  - OpenAI accepts webm natively — no client-side conversion needed
- **Implications**:
  - Three-tier MIME negotiation: `audio/webm;codecs=opus` → `audio/webm` → browser default
  - No audio conversion step needed — browser webm sent directly through proxy to OpenAI

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Direct browser→V2T | Browser calls V2T server directly | Simpler, fewer hops | V2T binds localhost only; breaks remote/Tailscale access | Rejected |
| CSM proxy | Browser→CSM API→V2T | Works remotely, centralized auth point | Extra hop adds latency | Selected — matches CSM's role as control plane |
| WebSocket streaming | Stream audio chunks in real-time | Lower latency start | Complexity, V2T not designed for streaming | Deferred — batch is sufficient for dictation |

## Design Decisions

### Decision: CSM Proxy Architecture
- **Context**: V2T server binds to localhost; CSM may be accessed remotely via Tailscale
- **Alternatives Considered**:
  1. Direct browser→V2T — breaks remote access
  2. CSM API proxy — adds hop but enables remote
  3. CSM WebSocket relay — streaming complexity not justified
- **Selected Approach**: CSM API proxy route forwards multipart form data to V2T
- **Rationale**: CSM already serves as the control plane; voice is another resource it proxies. Pattern matches existing API routes
- **Trade-offs**: +Remote access, +Centralized error handling; −Extra network hop (negligible for audio dictation)
- **Follow-up**: Monitor transcription latency in production

### Decision: No New Dependencies
- **Context**: Both projects aim for minimal dependency footprint
- **Selected Approach**: Bun.serve() for V2T server, native MediaRecorder for browser audio, native fetch for CSM proxy
- **Rationale**: Bun.serve() is zero-config HTTP server. MediaRecorder is well-supported. No form parsing library needed (Bun FormData is built-in)
- **Trade-offs**: +No dependency management; −Bun.serve() less featureful than Express (acceptable for 2 routes)

### Decision: Health-Gated Voice Button
- **Context**: Voice server is optional; should not break UI when down
- **Selected Approach**: Voice button renders only when health check returns available. Periodic re-check every 30s
- **Rationale**: Graceful degradation — UI remains clean when voice is unavailable. Re-check enables button to appear/disappear dynamically
- **Trade-offs**: +Clean UX when voice unavailable; −30s delay for button to appear after V2T starts

## Risks & Mitigations
- **V2T server not running** — Health-gated button hides feature entirely; no broken state
- **Microphone permission denied** — Clear error message via existing promptError display
- **Long transcription (>60s)** — AbortSignal timeout at CSM proxy; user sees timeout error
- **Claude cleanup failure** — V2T falls back to raw transcription (existing behavior)
- **Browser MIME type incompatibility** — Three-tier fallback chain for MediaRecorder format

## References
- [OpenAI Audio Transcription API](https://platform.openai.com/docs/guides/speech-to-text) — Supported formats: mp3, mp4, mpeg, mpga, m4a, wav, webm
- [MDN MediaRecorder API](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder) — Browser audio recording
- [Bun.serve() Documentation](https://bun.sh/docs/api/http) — Built-in HTTP server
