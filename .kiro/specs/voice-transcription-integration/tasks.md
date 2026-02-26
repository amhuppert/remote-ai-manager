# Implementation Plan

- [x] 1. Voice2Text foundational extensions
- [x] 1.1 (P) Extract the context file reader into a shared utility
  - Move the function that reads context files and builds the transcription prompt out of the CLI entry point into a dedicated shared module
  - Both the CLI mode and the new server mode need this function, so it must be importable from a common location
  - Update the CLI entry point to import from the new location instead of using its inline copy
  - Verify existing CLI behavior is unchanged after the extraction
  - _Requirements: 1.3_
  - _Contracts: ContextUtil Service_

- [x] 1.2 (P) Add project directory support to configuration resolution
  - Extend the local config loader to accept an optional base directory parameter; when provided, load the project-level voice config (`voice.json`) from that directory instead of the current working directory
  - Extend the top-level config resolver to accept an optional `projectDir` parameter that overrides the working directory for both local config loading and relative path resolution (context files, instructions files)
  - When the parameter is omitted, all behavior remains identical to the current implementation (backward compatible)
  - Resolve all relative file references (context files, instructions files) relative to the provided project directory
  - Add unit tests: config resolution with `projectDir` produces correct absolute paths; without `projectDir` behaves identically to current
  - _Requirements: 2.1, 2.2, 2.3_
  - _Contracts: ConfigLoader Service_

- [x] 1.3 (P) Add multi-format audio support to the transcriber
  - Replace the hardcoded WAV MIME type and filename in the transcription service with extension-based derivation
  - Support at minimum: `.wav` (audio/wav), `.webm` (audio/webm), `.mp3` (audio/mpeg), `.ogg` (audio/ogg), `.flac` (audio/flac), `.m4a` (audio/mp4)
  - Default to `audio/wav` with filename `audio.wav` for unrecognized extensions (backward compatible)
  - Add unit tests: each supported extension maps correctly; unrecognized extensions fall back to WAV
  - _Requirements: 3.1, 3.2, 3.3_
  - _Contracts: Transcriber Service_

- [x] 2. Voice2Text HTTP server
- [x] 2.1 Add server-related type definitions
  - Add types for server configuration (port, host), transcription response, error response, and health response to the existing types module
  - _Requirements: 1.1, 1.2_

- [x] 2.2 Implement the HTTP server with transcription and health endpoints
  - Create the HTTP server module using the runtime's built-in server (Bun.serve)
  - On startup, validate that the OpenAI API key environment variable is set; exit with an error if missing
  - Create a shared transcriber instance to reuse across requests
  - **Health endpoint** (GET /health): return status "ok" and a version string
  - **Transcribe endpoint** (POST /transcribe): parse multipart form data to extract the audio file and optional project path; write audio to a uniquely-named temp file; resolve config using the project path (or fall back to global config); build the transcription prompt from context files; transcribe via OpenAI; clean up via Claude CLI; delete the temp file in a finally block; return the cleaned text
  - If Claude cleanup fails, fall back to returning the raw transcription
  - Return 400 if the audio field is missing; return 404 for unknown routes
  - Add CORS header (`Access-Control-Allow-Origin: *`) to all responses
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 9.6_
  - _Contracts: V2TServer API_

- [x] 2.3 Add the serve subcommand to the CLI entry point
  - Register a `serve` subcommand with options for port (default 7880), host (default 127.0.0.1), and verbose logging
  - The default action (no subcommand) continues to run the existing CLI mode unchanged
  - Add a `serve` npm script to package.json for convenience
  - Manually verify: start the server and confirm the health endpoint responds correctly
  - _Requirements: 1.1_

- [x] 3. CSM voice API proxy routes
- [x] 3.1 (P) Implement the voice health check proxy route
  - Create a GET route at `/api/voice/health` that proxies to the Voice2Text server's health endpoint
  - Read the Voice2Text server URL from the `VOICE_SERVER_URL` environment variable (default: `http://localhost:7880`)
  - Use a 3-second timeout; return `{ available: true }` on success, `{ available: false }` on any error
  - No tracing wrapper needed (lightweight poll endpoint)
  - _Requirements: 5.1, 5.2_
  - _Contracts: HealthRoute API_

- [x] 3.2 (P) Implement the voice transcription proxy route
  - Create a POST route at `/api/voice/transcribe` wrapped with the existing tracing middleware
  - Extract `audio` (file) and `projectName` (string) from the incoming FormData; return 400 if either is missing
  - Resolve the project name to a project path using the existing project resolver; return 404 if not found
  - Forward the audio file and resolved project path as FormData to the Voice2Text server's transcribe endpoint
  - Use a 60-second timeout via AbortSignal
  - Map errors: Voice2Text unreachable → 502; Voice2Text error → forward upstream status; timeout → 504
  - Read the Voice2Text server URL from the `VOICE_SERVER_URL` environment variable (default: `http://localhost:7880`)
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 9.3, 9.4, 9.5_
  - _Contracts: TranscribeRoute API_

- [x] 4. CSM browser audio recording and styles
- [x] 4.1 (P) Create the voice recording React hook
  - Implement a custom hook that manages the full audio recording lifecycle: idle → recording → processing → idle
  - **Availability**: On mount, check the voice health API; re-check every 30 seconds. Also verify `navigator.mediaDevices` exists. Report unavailable if either check fails
  - **Start recording**: Request microphone access via `getUserMedia`; create a `MediaRecorder` preferring `audio/webm;codecs=opus`, falling back to `audio/webm`, then browser default; collect audio chunks; start a 1-second interval for elapsed time tracking; set a max-duration timeout (default 300 seconds) that auto-stops recording
  - **Stop recording**: Stop the MediaRecorder; assemble chunks into a Blob; transition to processing; send the audio and project name to the transcription API via FormData; deliver the result or error via callbacks
  - **Cleanup**: On unmount, stop any active recording, clear all timers, and abort in-flight requests via AbortController
  - **Errors**: Report "Microphone access denied" if getUserMedia fails; report "Recording too short" if recording lasted less than 0.5 seconds
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 9.1, 9.2_
  - _Contracts: useVoiceRecorder State_

- [x] 4.2 (P) Add voice recording CSS animations and button styles
  - Add a pulsing red glow keyframe animation for the recording state, using the existing `--red` design token
  - Add a `.voice-recording` class that applies the pulse animation with red border and text color
  - Add `.voice-btn` styles: 48x48px button matching the send button dimensions, using design system tokens for border, text color, radius, and hover/disabled states
  - Add `.voice-timer` badge styles: absolute-positioned, red background, mono font, compact sizing
  - Place the keyframe near the existing `pulse-border` animation; place the button styles near the existing `.send-btn` rules
  - _Requirements: 7.3, 7.4_

- [x] 5. CSM voice button and page integration
- [x] 5.1 Create the voice record button component
  - Build a component that uses the recording hook internally and renders three visual states:
    - **Hidden**: Return null when the voice server is unavailable
    - **Idle**: Microphone icon button; starts recording on click
    - **Recording**: Stop square icon with pulsing red animation; shows elapsed time as mm:ss badge
    - **Processing**: Disabled button with spinner indicator
  - Accept `projectName`, `onResult`, `onError`, and optional `disabled` props
  - Use inline SVG for the microphone and stop icons (no external icon library)
  - Disable when the parent signals it (e.g., during prompt sending)
  - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6_
  - _Contracts: VoiceRecordButton_

- [x] 5.2 Integrate the voice button into the session detail page
  - Pass the resolved `projectPath` from the server component through to the client component's props
  - Add a voice result handler that appends transcribed text to the existing prompt textarea content, separated by a newline if content already exists
  - Add a voice error handler that routes errors through the existing prompt error display mechanism (`setPromptError`)
  - Place the voice record button inside the prompt input wrapper, between the textarea and the send button
  - Disable the voice button while a prompt is being sent (`sending` state)
  - _Requirements: 8.1, 8.2, 8.3, 8.4_

- [x] 6. Context-aware voice transcription
- [x] 6.1 (P) Add context support to the Voice2Text server transcribe handler
  - In the transcribe endpoint handler, extract an optional `context` string field from the incoming multipart form data
  - When `context` is present and non-empty, pass it as the `priorOutput` parameter to the cleanup service so the cleanup uses the file-mode continuation prompt template
  - When `context` is absent or empty, continue using the standard cleanup prompt template (no behavioral change)
  - The cleanup service already accepts `priorOutput` as its fourth argument — no changes to the cleanup service itself are needed
  - _Requirements: 10.4, 10.5_
  - _Contracts: V2TServer API_

- [x] 6.2 (P) Forward the context field through the CSM transcription proxy route
  - In the voice transcription proxy route, extract an optional `context` string field from the incoming FormData
  - When building the upstream FormData to forward to the Voice2Text server, include the `context` field if it was present and non-empty in the original request
  - The field is optional — omitting it preserves existing behavior with no validation errors
  - _Requirements: 10.3_
  - _Contracts: TranscribeRoute API_

- [x] 6.3 Add context passing to the voice recording hook and wire it in both UI consumers
  - Add an optional `getContext` callback to the recording hook's options that returns the current input text
  - When building the FormData for the transcription request (after recording stops), call `getContext` if provided; include the result as a `context` field if it returns a non-empty trimmed string; omit the field otherwise
  - In the session detail page, pass a `getContext` callback to the recording hook that returns the current prompt textarea value
  - In the focus mode session creation modal, pass a `getContext` callback to the recording hook that returns the current objective textarea value
  - Both consumers should provide stable (memoized) callbacks to avoid unnecessary hook re-renders
  - _Requirements: 10.1, 10.2, 10.6_
  - _Contracts: useVoiceRecorder State_
