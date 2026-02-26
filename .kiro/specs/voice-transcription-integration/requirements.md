# Requirements Document

## Introduction

This specification covers integrating browser-based voice transcription into CSM by extending the existing Voice2Text CLI tool into an HTTP server and adding audio capture with a voice button UI in CSM's session detail page. The feature spans two workstreams: Voice2Text server extension and CSM voice integration. The browser captures audio via MediaRecorder, sends it through a CSM API proxy route, which forwards it to the Voice2Text HTTP server with project context for transcription and cleanup. The cleaned text is returned and populates the prompt textarea. Additionally, when the user initiates voice recording from a text input that already contains text, that existing text is automatically sent as additional context to the Voice2Text server so that the cleanup phase can produce output that flows naturally from the prior content.

## Requirements

### Requirement 1: Voice2Text HTTP Server Mode

**Objective:** As a developer, I want Voice2Text to run as an HTTP server, so that CSM can send audio for transcription over HTTP instead of requiring CLI invocation.

#### Acceptance Criteria

1. When the `serve` subcommand is invoked, the Voice2Text CLI shall start an HTTP server on the configured host and port (default: 127.0.0.1:7880).
2. When a `GET /health` request is received, the Voice2Text server shall respond with a JSON body containing `status: "ok"` and a `version` string.
3. When a `POST /transcribe` request is received with a multipart form containing an `audio` file, the Voice2Text server shall transcribe the audio using OpenAI, clean up the result using Claude CLI, and return a JSON body with the cleaned `text`.
4. If the `POST /transcribe` request includes a `projectPath` field, the Voice2Text server shall load the voice configuration (`voice.json`) from that project directory for transcription context and cleanup settings.
5. If the `POST /transcribe` request omits the `projectPath` field, the Voice2Text server shall fall back to the global configuration.
6. When transcription completes, the Voice2Text server shall delete the temporary audio file regardless of success or failure.
7. If the `OPENAI_API_KEY` environment variable is not set, the Voice2Text server shall exit with an error on startup.
8. The Voice2Text server shall include CORS headers (`Access-Control-Allow-Origin: *`) on all responses.
9. When a request is made to an unknown route, the Voice2Text server shall respond with 404 and `{ error: "Not found" }`.

### Requirement 2: Voice2Text Multi-Project Configuration

**Objective:** As a developer managing multiple projects, I want Voice2Text to load project-specific voice configuration from an arbitrary directory, so that each project gets tailored transcription context and cleanup instructions.

#### Acceptance Criteria

1. When a `projectDir` parameter is provided to config resolution, the Voice2Text config loader shall load `voice.json` from that directory instead of `process.cwd()`.
2. When a `projectDir` is provided, the Voice2Text config loader shall resolve all relative paths (context files, instructions files) relative to that directory.
3. If no `projectDir` is provided, the Voice2Text config loader shall behave identically to its current behavior (using `process.cwd()`).

### Requirement 3: Voice2Text Audio Format Support

**Objective:** As a developer, I want Voice2Text to accept multiple audio formats beyond WAV, so that browser-recorded WebM audio can be transcribed directly without conversion.

#### Acceptance Criteria

1. The Voice2Text transcriber shall derive the MIME type and filename from the audio file's extension when creating the OpenAI transcription request.
2. The Voice2Text transcriber shall support at minimum: `.wav`, `.webm`, `.mp3`, `.ogg`, `.flac`, and `.m4a` file extensions with their corresponding MIME types.
3. If the file extension is unrecognized, the Voice2Text transcriber shall default to `audio/wav` for backward compatibility.

### Requirement 4: CSM Voice Transcription API Proxy

**Objective:** As a developer using CSM remotely (e.g., via Tailscale), I want CSM to proxy voice transcription requests to the Voice2Text server, so that the browser does not need direct access to the localhost-bound Voice2Text service.

#### Acceptance Criteria

1. When a `POST /api/voice/transcribe` request is received with a FormData body containing `audio` (file) and `projectName` (string), the CSM API route shall forward the audio and resolved project path to the Voice2Text server and return the transcribed text.
2. If the `audio` field is missing from the request, the CSM API route shall respond with 400 and an error message.
3. If the `projectName` field is missing from the request, the CSM API route shall respond with 400 and an error message.
4. If the project name cannot be resolved to a valid project path, the CSM API route shall respond with 404.
5. If the Voice2Text server is unreachable, the CSM API route shall respond with 502 and an appropriate error message.
6. If the Voice2Text server returns an error, the CSM API route shall forward the upstream status code and error message.
7. If the transcription request exceeds 60 seconds, the CSM API route shall abort and respond with 504.
8. The CSM API route shall read the Voice2Text server URL from the `VOICE_SERVER_URL` environment variable, defaulting to `http://localhost:7880`.

### Requirement 5: CSM Voice Health Monitoring

**Objective:** As a developer, I want CSM to check whether the Voice2Text server is available, so that the voice button only appears when the service is operational.

#### Acceptance Criteria

1. When a `GET /api/voice/health` request is received, the CSM API route shall check the Voice2Text server's health endpoint and return `{ available: true }` or `{ available: false }`.
2. If the Voice2Text server does not respond within 3 seconds, the CSM health route shall return `{ available: false }`.

### Requirement 6: CSM Browser Audio Recording

**Objective:** As a developer, I want CSM to capture audio from my microphone in the browser, so that I can dictate prompts using my voice.

#### Acceptance Criteria

1. When the user starts a voice recording, the CSM recording hook shall request microphone access via `getUserMedia` and capture audio using MediaRecorder.
2. The CSM recording hook shall prefer `audio/webm;codecs=opus` format, falling back to `audio/webm`, then the browser default.
3. When the user stops recording, the CSM recording hook shall assemble the captured audio into a Blob, send it to the CSM transcription API with the project name, and deliver the transcribed text via a callback.
4. While recording is active, the CSM recording hook shall track elapsed time in seconds.
5. While recording has been active for the maximum duration (default 300 seconds), the CSM recording hook shall automatically stop the recording.
6. When the component using the recording hook unmounts, the CSM recording hook shall stop any active recording, clear all timers, and abort any in-flight transcription requests.
7. The CSM recording hook shall check voice server availability on mount and re-check periodically (every 30 seconds).
8. If microphone access is denied or the voice server is unavailable, the CSM recording hook shall report itself as unavailable.

### Requirement 7: CSM Voice Record Button UI

**Objective:** As a developer, I want a voice input button on the session detail page, so that I can easily switch between typing and dictating prompts.

#### Acceptance Criteria

1. While the voice server is unavailable, the VoiceRecordButton component shall not render (return null).
2. While in idle state, the VoiceRecordButton shall display a microphone icon button that starts recording on click.
3. While recording is active, the VoiceRecordButton shall display a stop icon with a pulsing red animation and show the elapsed time as a `mm:ss` badge.
4. While transcription is processing, the VoiceRecordButton shall display a disabled button with a spinner indicator.
5. When the parent component is in a disabled state (e.g., sending a prompt), the VoiceRecordButton shall be disabled.
6. The VoiceRecordButton shall use inline SVG icons (microphone and stop square) without requiring an external icon library.

### Requirement 8: CSM Session Detail Page Integration

**Objective:** As a developer, I want the voice recording button integrated into the session prompt area, so that voice input flows naturally alongside the existing text input workflow.

#### Acceptance Criteria

1. The VoiceRecordButton shall be placed inside the prompt input wrapper, between the textarea and the send button.
2. When a voice transcription result is received, the session detail page shall append the text to any existing content in the prompt textarea (separated by a newline if content already exists).
3. When a voice transcription error occurs, the session detail page shall display it using the existing prompt error display mechanism.
4. The session detail page server component shall pass the resolved `projectPath` prop to the session detail client component.

### Requirement 9: Error Handling and Recovery

**Objective:** As a developer, I want clear feedback when voice transcription fails, so that I understand what went wrong and can take corrective action.

#### Acceptance Criteria

1. If microphone permission is denied, the CSM recording hook shall report the error "Microphone access denied".
2. If the recording is shorter than 0.5 seconds, the CSM recording hook shall report the error "Recording too short".
3. If the Voice2Text server returns an error, the CSM API route shall forward the error message to the client for display.
4. If the transcription request times out, the CSM shall display "Transcription timed out".
5. If the Voice2Text server becomes unreachable mid-request, the CSM shall display "Voice server is not available".
6. If Claude cleanup fails on the Voice2Text server, the Voice2Text server shall fall back to returning the raw (unformatted) transcription.

### Requirement 10: Context-Aware Voice Transcription

**Objective:** As a developer, I want the voice transcription to consider any text already typed in the input field, so that the cleaned transcription flows naturally from my existing content rather than being formatted in isolation.

#### Acceptance Criteria

1. When the user initiates voice recording and the associated text input contains existing text, the CSM recording hook shall include that text as a `context` field in the transcription request FormData.
2. If the associated text input is empty when recording starts, the CSM recording hook shall omit the `context` field from the transcription request.
3. When the CSM transcription API proxy receives a `context` field in the request FormData, the CSM API route shall forward it to the Voice2Text server as a `context` field.
4. When the Voice2Text server receives a `context` field in the `POST /transcribe` request, the Voice2Text server shall pass it as the `priorOutput` parameter to the cleanup service so the transcription is formatted to continue naturally from the existing content.
5. If the `context` field is omitted from the `POST /transcribe` request, the Voice2Text server shall perform cleanup using the standard (non-continuation) prompt template.
6. The context-passing behavior shall work identically in both the session detail prompt textarea and the focus mode session creation objective textarea.

