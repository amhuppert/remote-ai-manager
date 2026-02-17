# Voice Transcription Integration — Implementation Plan

## Overview

Integrate browser-based voice transcription into CSM by extending the existing Voice2Text CLI tool (`/home/alex/github/my-ai-resources/voice-to-text`) into an HTTP server and adding audio capture + voice button UI in CSM's session detail page.

**Architecture**: Browser captures audio via MediaRecorder → sends to CSM API proxy route → CSM forwards to Voice2Text HTTP server with project path → server runs transcription (OpenAI) + cleanup (Claude CLI) → returns cleaned text → populates prompt textarea.

**Two workstreams**:
1. Voice2Text server extension (changes to the voice-to-text project)
2. CSM voice integration (changes to the CSM project)

## Architecture

```
Browser (any machine)
  │ POST /api/voice/transcribe  (FormData: audio blob + projectName)
  ▼
CSM Next.js API Route (machine A)
  │ resolves projectName → projectPath
  │ POST http://localhost:7880/transcribe  (FormData: audio blob + projectPath)
  ▼
Voice2Text Server (machine A, localhost:7880)
  │ loads voice.json from projectPath
  │ writes audio to temp file
  │ transcribes via OpenAI gpt-4o-transcribe
  │ cleans up via Claude CLI with project context
  │ deletes temp file
  ▼
Returns { text: "cleaned transcription" }
  ▼
CSM API Route → Browser → populates prompt textarea
```

CSM proxies the request rather than having the browser call Voice2Text directly because Voice2Text runs on localhost and CSM may be accessed remotely via Tailscale.

## Technology Stack

| Component | Technology |
|---|---|
| Voice2Text server | Bun.serve() (built-in, zero new dependencies) |
| Audio format from browser | WebM/Opus via MediaRecorder (OpenAI accepts webm natively) |
| CSM audio recording | Custom React hook wrapping native MediaRecorder API |
| CSM voice button | React component with CSS animations |
| CSM proxy route | Next.js App Router route handler |
| CSM ↔ Voice2Text | HTTP multipart/form-data via fetch |

No new npm dependencies required in either project.

## File Structure

### Voice2Text Changes

```
voice-to-text/src/
  main.ts              # MODIFIED: add 'serve' subcommand
  server.ts            # NEW: HTTP server implementation
  types.ts             # MODIFIED: add ServerConfig type
  utils/
    config.ts          # MODIFIED: accept projectDir parameter
  services/
    transcriber.ts     # MODIFIED: support non-wav MIME types
    cleanup.ts         # UNCHANGED
    ...                # UNCHANGED
```

### CSM Changes

```
remote-ai-manager/src/
  app/
    api/
      voice/
        transcribe/
          route.ts             # NEW: proxy API route
        health/
          route.ts             # NEW: health check proxy
    projects/[name]/[session]/
      SessionDetailPage.tsx    # MODIFIED: add voice button
      page.tsx                 # MODIFIED: pass projectPath prop
    globals.css                # MODIFIED: add recording animation
  hooks/
    useVoiceRecorder.ts        # NEW: audio recording hook
  components/
    VoiceRecordButton.tsx      # NEW: voice button component
```

---

## Component Specifications

### 1. Voice2Text: Config Resolution Changes

**File**: `voice-to-text/src/utils/config.ts`

**Change**: Add `projectDir` parameter to `resolveConfig()` and `loadLocalConfig()` to allow loading `voice.json` from an arbitrary directory instead of `process.cwd()`.

`loadLocalConfig(baseDir?: string)` — when `baseDir` is provided, use it instead of `process.cwd()` to find `voice.json`. All relative paths in that config resolve relative to `baseDir`.

`resolveConfig({ configPath?, cliOpts, projectDir? })` — when `projectDir` is provided, it replaces `process.cwd()` in:
- Loading the local `voice.json`
- Resolving relative paths for context files, instructions files, and output file

This is the key change that enables multi-project support. Existing CLI behavior is unchanged (projectDir defaults to undefined, falling back to process.cwd()).

### 2. Voice2Text: Transcriber MIME Type Support

**File**: `voice-to-text/src/services/transcriber.ts`

**Change**: The `transcribe()` method currently hardcodes `audio/wav` MIME type and `audio.wav` filename when creating the File object for OpenAI. Derive these from the file extension of the input path:

```
Extension mapping:
  .wav  → audio/wav
  .webm → audio/webm
  .mp3  → audio/mpeg
  .ogg  → audio/ogg
  .flac → audio/flac
  .m4a  → audio/mp4
  default → audio/wav (backward compatible)
```

Extract extension from `audioFilePath` using `path.extname()`. Use it to set both the MIME type and the filename (`audio.{ext}`) in the File constructor. This is a backward-compatible change — existing `.wav` files work identically.

### 3. Voice2Text: Server Types

**File**: `voice-to-text/src/types.ts`

Add:

```typescript
export interface ServerConfig {
  port: number;     // default: 7880
  host: string;     // default: "127.0.0.1"
}

export interface TranscribeRequest {
  audio: File;
  projectPath?: string;
}

export interface TranscribeResponse {
  text: string;
}

export interface TranscribeErrorResponse {
  error: string;
}

export interface HealthResponse {
  status: "ok";
  version: string;
}
```

### 4. Voice2Text: HTTP Server

**File**: `voice-to-text/src/server.ts`

**Exports**: `startServer(options: { port: number; host: string; verbose: boolean }): void`

**Implementation using Bun.serve()**:

**Startup**:
1. Validate `OPENAI_API_KEY` env var exists (exit with error if not)
2. Create a shared transcriber instance (reused across requests — it only holds the OpenAI client)
3. Start Bun.serve() on the configured host:port

**Routes**:

`GET /health`:
- Return `{ status: "ok", version: "1.0.0" }` with 200

`POST /transcribe`:
- Parse multipart form data from request body using `request.formData()`
- Extract `audio` field (File) — return 400 if missing
- Extract `projectPath` field (string, optional)
- Generate temp file path: `/tmp/voice-to-text-${Date.now()}-${Math.random().toString(36).slice(2)}.{ext}` where ext is derived from the audio file's name or type (webm for audio/webm, wav for audio/wav, etc.)
- Write audio buffer to temp file: `await Bun.write(tempPath, audio)`
- Resolve config: `resolveConfig({ cliOpts: {}, projectDir: projectPath || undefined })`
- Build transcription prompt from context files (reuse `readContextFilesContent()` from main.ts — extract it to a shared util)
- Transcribe: `transcriber.transcribe(tempPath, transcriptionPrompt)`
- Create cleanup service: `createCleanupService(config.claudeModel, verbose)`
- Cleanup: `cleanupService.cleanup(transcription, config.contextFiles, config.instructionsFiles)` — no priorOutput (always clipboard-mode cleanup for server)
- Delete temp file
- Return `{ text: cleanedText }` with 200
- On error: delete temp file in finally block, return `{ error: message }` with 500

**All other routes**: Return 404 `{ error: "Not found" }`

**CORS**: Add `Access-Control-Allow-Origin: *` header to all responses (allows direct browser access if needed in the future, though currently proxied through CSM).

### 5. Voice2Text: Main Entry Point Changes

**File**: `voice-to-text/src/main.ts`

**Change**: Add a `serve` subcommand to the existing Commander program.

Keep the existing top-level program options and `.action()` for CLI mode (backward compatible). Add:

```
program
  .command("serve")
  .description("Run as HTTP server for voice transcription")
  .option("--port <number>", "Server port", parseInt, 7880)
  .option("--host <host>", "Server host", "127.0.0.1")
  .option("--verbose", "Enable verbose logging", false)
  .action((opts) => { startServer(opts); });
```

The default action (no subcommand) continues to run the existing CLI mode. `voice-to-text serve --port 7880` starts the HTTP server.

**Extract `readContextFilesContent()`** from main.ts into a new shared utility file `src/utils/context.ts` so both main.ts and server.ts can use it.

### 6. Voice2Text: Build Configuration

**File**: `voice-to-text/package.json`

Add script:

```json
"serve": "bun run src/main.ts serve"
```

The compiled binary (`bun build src/main.ts --compile --outfile dist/voice-to-text`) already includes all code — the serve subcommand will work with the compiled binary too.

---

### 7. CSM: Voice Transcribe API Route

**File**: `src/app/api/voice/transcribe/route.ts`

```typescript
// POST /api/voice/transcribe
// Receives: FormData with 'audio' (Blob) and 'projectName' (string)
// Returns: { text: string } or { error: string }
```

**Implementation**:
1. Parse FormData from request: `const formData = await request.formData()`
2. Extract `audio` (File) and `projectName` (string) — return 400 if either missing
3. Resolve project path: `const projectPath = await resolveProjectPath(projectName)` — return 404 if null
4. Read `VOICE_SERVER_URL` from `process.env.VOICE_SERVER_URL` (default: `http://localhost:7880`)
5. Create new FormData for upstream request:
   - Append the audio file: `upstream.append("audio", audio)`
   - Append the project path: `upstream.append("projectPath", projectPath)`
6. Fetch from Voice2Text server with 60-second timeout:
   ```
   const response = await fetch(`${voiceServerUrl}/transcribe`, {
     method: "POST",
     body: upstream,
     signal: AbortSignal.timeout(60000),
   });
   ```
7. If response not ok, parse error and return with upstream status code
8. Parse response JSON and return `{ text }` with 200
9. Wrap the handler with `withTracing` (existing pattern from other routes)

**Error cases**:
- Missing audio/projectName → 400 `{ error: "Missing audio file" }` or `{ error: "Missing projectName" }`
- Project not found → 404 `{ error: "Project not found" }`
- Voice server unreachable → 502 `{ error: "Voice server is not available" }`
- Voice server error → forward status code and error message
- Timeout → 504 `{ error: "Transcription timed out" }`

### 8. CSM: Voice Health API Route

**File**: `src/app/api/voice/health/route.ts`

```typescript
// GET /api/voice/health
// Returns: { available: boolean }
```

**Implementation**:
1. Read `VOICE_SERVER_URL` from env (default: `http://localhost:7880`)
2. Fetch `${voiceServerUrl}/health` with 3-second timeout
3. If response ok → return `{ available: true }`
4. On any error → return `{ available: false }`

No authentication. No tracing needed (lightweight health check).

### 9. CSM: useVoiceRecorder Hook

**File**: `src/hooks/useVoiceRecorder.ts`

**Interface**:

```typescript
interface UseVoiceRecorderOptions {
  projectName: string;
  maxDuration?: number;   // seconds, default 300
  onResult: (text: string) => void;
  onError: (error: string) => void;
}

interface UseVoiceRecorderReturn {
  isRecording: boolean;
  isProcessing: boolean;
  elapsedTime: number;    // seconds elapsed while recording
  isAvailable: boolean;   // false if voice server is down or mic permission denied
  toggleRecording: () => void;
}
```

**Internal state machine**: `idle` → `recording` → `processing` → `idle`

**Implementation details**:

**Availability check** (on mount):
- Call `GET /api/voice/health`
- Set `isAvailable` based on response
- Also check `navigator.mediaDevices` exists (HTTPS/localhost required)
- Re-check every 30 seconds while component is mounted

**startRecording()**:
1. Request microphone: `navigator.mediaDevices.getUserMedia({ audio: true })`
2. Create MediaRecorder with mimeType `audio/webm;codecs=opus`
   - If unsupported, fall back to `audio/webm`, then default
3. Collect chunks in `dataavailable` handler
4. Start MediaRecorder
5. Start elapsed time interval (1-second ticks)
6. Set max duration timeout — auto-stop at `maxDuration` seconds

**stopRecording()**:
1. Stop MediaRecorder → triggers final `dataavailable` + `stop` event
2. Clear elapsed time interval and max duration timeout
3. In `stop` handler: create Blob from chunks
4. Transition to `processing` state
5. Create FormData with audio blob (named `recording.webm`) and `projectName`
6. Fetch `POST /api/voice/transcribe` with FormData, 60-second timeout via AbortSignal
7. On success: call `onResult(data.text)`, transition to `idle`
8. On error: call `onError(message)`, transition to `idle`

**Cleanup** (on unmount): Stop any active MediaRecorder, clear timers, abort in-flight fetch via AbortController.

### 10. CSM: VoiceRecordButton Component

**File**: `src/components/VoiceRecordButton.tsx`

**Props**:

```typescript
interface VoiceRecordButtonProps {
  projectName: string;
  onResult: (text: string) => void;
  disabled?: boolean;       // e.g., when session is busy sending a prompt
}
```

**Implementation**:
- Uses `useVoiceRecorder` hook internally
- If `!isAvailable`: render nothing (return null) — voice button is invisible when server is down
- Three visual states:

**Idle state**:
- Render `btn-icon-only` button (same style as existing topbar buttons) with SVG microphone icon
- `data-tooltip="Voice input"`
- On click: call `toggleRecording()`

**Recording state**:
- Button gets class `voice-recording` (pulsing red animation)
- Icon changes to a stop square
- Show elapsed time as `mm:ss` in a small badge next to the button
- `data-tooltip="Stop recording"`
- On click: call `toggleRecording()`

**Processing state**:
- Button disabled, show spinner (existing `.spinner` CSS class)
- `data-tooltip="Transcribing..."`

**Error handling**: Show error via the parent's error state (call `onError` which parent handles with existing `promptError` display).

**SVG Icons** (inline, no icon library):
- Microphone: Simple mic path (12x18 viewBox)
- Stop: Filled square (simple rect)

### 11. CSM: SessionDetailPage Integration

**File**: `src/app/projects/[name]/[session]/SessionDetailPage.tsx`

**Changes**:

1. **Add `projectPath` to Props**: The page server component already resolves this — pass it through.

   ```typescript
   interface Props {
     projectName: string;
     projectPath: string;    // NEW
     session: SessionState;
     messages: TranscriptMessage[];
     diff: SessionDiff;
   }
   ```

2. **Import VoiceRecordButton**: Add to imports.

3. **Add voice result handler**:
   ```typescript
   const handleVoiceResult = useCallback((text: string) => {
     setPromptText(prev => prev ? prev + "\n" + text : text);
   }, []);
   ```
   This appends transcribed text to any existing content in the textarea.

4. **Add voice error handler**: Route errors through existing `setPromptError`.

5. **Insert VoiceRecordButton in the prompt input area**: Place it immediately before the send button inside `.prompt-input-wrapper`:

   Current structure (lines 411-445):
   ```
   <div className="prompt-input-wrapper">
     <textarea ... />
     <button className="send-btn" ... />
   </div>
   ```

   New structure:
   ```
   <div className="prompt-input-wrapper">
     <textarea ... />
     <VoiceRecordButton
       projectName={projectName}
       onResult={handleVoiceResult}
       disabled={sending}
     />
     <button className="send-btn" ... />
   </div>
   ```

### 12. CSM: Server Component Changes

**File**: `src/app/projects/[name]/[session]/page.tsx`

Pass `projectPath` to SessionDetailPage:

```typescript
<SessionDetailPage
  projectName={name}
  projectPath={projectPath}    // ADD THIS
  session={sessionState}
  messages={messages}
  diff={diff}
/>
```

`projectPath` is already resolved on line 20 of this file.

### 13. CSM: CSS Additions

**File**: `src/app/globals.css`

Add after the existing `pulse-border` keyframe animation (around line 202):

```css
/* Voice recording pulse animation */
@keyframes voice-recording-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(255, 61, 90, 0.4); }
  50% { box-shadow: 0 0 0 8px rgba(255, 61, 90, 0); }
}

.voice-recording {
  animation: voice-recording-pulse 1.5s ease-in-out infinite;
  border-color: var(--red) !important;
  color: var(--red) !important;
}
```

Add after the `.send-btn:disabled` rule (around line 1684):

```css
/* Voice button — sits next to send button */
.voice-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--text-secondary);
  font-size: 1.1rem;
  transition: all 0.15s ease;
  flex-shrink: 0;
  position: relative;
}

.voice-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
  border-color: var(--border-strong);
}

.voice-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.voice-btn .voice-timer {
  position: absolute;
  top: -6px;
  right: -6px;
  padding: 1px 5px;
  background: var(--red);
  color: var(--text-inverse);
  font-family: var(--font-mono);
  font-size: 0.58rem;
  font-weight: 600;
  border-radius: 100px;
  line-height: 1.4;
}
```

---

## Implementation Steps

Execute in this exact order. Each step should be verified before proceeding.

### Phase 1: Voice2Text Server Extension

1. **Extract shared utility** — Move `readContextFilesContent()` from `voice-to-text/src/main.ts` into a new file `voice-to-text/src/utils/context.ts`. Export it. Update main.ts to import from the new location.

2. **Parameterize config resolution** — Modify `voice-to-text/src/utils/config.ts`:
   - Add `baseDir?: string` parameter to `loadLocalConfig()`
   - Add `projectDir?: string` to `resolveConfig()` options
   - When provided, use `projectDir` instead of `process.cwd()` for local config loading and relative path resolution

3. **Add MIME type support to transcriber** — Modify `voice-to-text/src/services/transcriber.ts` to derive MIME type and filename from the file extension of the input path instead of hardcoding `audio/wav`.

4. **Add server types** — Add `ServerConfig`, `TranscribeResponse`, `TranscribeErrorResponse`, and `HealthResponse` to `voice-to-text/src/types.ts`.

5. **Create HTTP server** — Write `voice-to-text/src/server.ts` implementing `startServer()` as specified above.

6. **Add serve subcommand** — Modify `voice-to-text/src/main.ts` to add the `serve` Commander subcommand.

7. **Add serve script** — Add `"serve": "bun run src/main.ts serve"` to `voice-to-text/package.json` scripts.

8. **Verify** — Run `bun run src/main.ts serve --port 7880` and test with:
   ```bash
   curl http://localhost:7880/health
   # Should return: {"status":"ok","version":"1.0.0"}
   ```

### Phase 2: CSM API Proxy Routes

9. **Create health check route** — Write `src/app/api/voice/health/route.ts` as specified.

10. **Create transcribe proxy route** — Write `src/app/api/voice/transcribe/route.ts` as specified.

11. **Verify** — With Voice2Text server running, test:
    ```bash
    curl http://localhost:3000/api/voice/health
    # Should return: {"available":true}
    ```

### Phase 3: CSM UI Integration

12. **Create useVoiceRecorder hook** — Write `src/hooks/useVoiceRecorder.ts` as specified.

13. **Add CSS styles** — Add voice recording animation and voice button styles to `src/app/globals.css` as specified.

14. **Create VoiceRecordButton component** — Write `src/components/VoiceRecordButton.tsx` as specified.

15. **Update server component** — Modify `src/app/projects/[name]/[session]/page.tsx` to pass `projectPath` prop.

16. **Integrate into SessionDetailPage** — Modify `src/app/projects/[name]/[session]/SessionDetailPage.tsx`:
    - Add `projectPath` to Props interface
    - Import VoiceRecordButton
    - Add handleVoiceResult callback
    - Insert VoiceRecordButton in prompt-input-wrapper between textarea and send button

17. **End-to-end test** — With both Voice2Text server and CSM dev server running:
    - Open a session detail page
    - Verify voice button appears (or is absent if server is down)
    - Click voice button, speak, click stop
    - Verify transcribed text appears in prompt textarea

---

## Error Handling

| Scenario | Handler | User Experience |
|---|---|---|
| Voice server not running | Health check returns `available: false` | Voice button hidden (not shown) |
| Microphone permission denied | getUserMedia rejects | Error toast via promptError: "Microphone access denied" |
| Empty/too-short recording | Client-side check (< 0.5s) | Error toast: "Recording too short" |
| Voice server returns error | API route forwards error | Error toast with server message |
| Network timeout (60s) | AbortSignal.timeout | Error toast: "Transcription timed out" |
| Voice server unreachable mid-request | fetch rejects | Error toast: "Voice server is not available" |
| OpenAI transcription fails | Server falls back to raw text on transcription, or returns error if total failure | Error toast if complete failure |
| Claude cleanup fails | Server falls back to raw transcription (existing behavior) | User gets unformatted text (acceptable) |

---

## Configuration

### Voice2Text Server

**Environment**:
- `OPENAI_API_KEY` — required for transcription

**CLI flags** (`voice-to-text serve`):
- `--port <number>` — server port (default: 7880)
- `--host <string>` — bind address (default: 127.0.0.1)
- `--verbose` — enable verbose logging

**Global config** (`~/.config/voice-to-text/config.json`): Existing fields apply as defaults for cleanup (claudeModel, etc.). Server-specific config is CLI-flag only.

### CSM

**Environment variable**:
- `VOICE_SERVER_URL` — URL of Voice2Text server (default: `http://localhost:7880`)

Set in `.env.local` or system environment:
```
VOICE_SERVER_URL=http://localhost:7880
```

### Per-Project Voice Config

Each project can have a `voice.json` at its root (already exists for CSM). The Voice2Text server loads this when it receives a request with that project's path. Format is the existing Voice2Text config format:

```json
{
  "contextFile": "./voice-context.md",
  "claudeModel": "sonnet"
}
```

Fields used by the server: `contextFile` (transcription hints + cleanup context), `instructionsFile` (cleanup instructions), `claudeModel` (cleanup model). Fields like `hotkey`, `fileHotkey`, `outputFile`, `autoInsert` are irrelevant in server mode and ignored.

---

## Testing

### Voice2Text

- **Unit**: config resolution with `projectDir` parameter produces correct paths
- **Unit**: transcriber MIME type mapping for different file extensions
- **Integration**: `POST /transcribe` with a short audio file returns transcribed text
- **Integration**: `GET /health` returns correct response
- **Integration**: `POST /transcribe` without audio returns 400
- **Integration**: `POST /transcribe` with invalid projectPath falls back to global config

### CSM

- **Unit**: `useVoiceRecorder` hook state transitions (mock MediaRecorder and fetch)
- **Unit**: `VoiceRecordButton` renders correctly in each state (idle, recording, processing, unavailable)
- **Integration**: `POST /api/voice/transcribe` proxies correctly to Voice2Text server
- **Integration**: `GET /api/voice/health` returns correct availability status
- **Integration**: Voice button hidden when health check returns unavailable
