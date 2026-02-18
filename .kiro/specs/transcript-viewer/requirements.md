# Requirements Document

## Introduction

The Transcript Viewer feature renders conversation messages within the session detail page. The **primary data source** for messages is the `session.messages` array, which is populated directly by the prompt execution feature (see `prompt-execution` spec, Requirement 8). This provides immediate message availability without depending on external hooks or transcript files.

As a **secondary/legacy capability**, the feature also includes a JSONL transcript parser (`readTranscript`) that can parse Claude Code transcript files from disk. This parser handles the full pipeline: reading JSONL files, parsing entries with Zod validation, filtering for message-type entries, and extracting text content from both string and content-block formats. The JSONL parser remains available for advanced debugging scenarios but is no longer the default data path for the session detail page.

## Requirements

### Requirement 1: JSONL File Reading

**Objective:** As a developer, I want transcript files to be read from disk, so that conversation history can be displayed for any session with a known transcript path.

#### Acceptance Criteria

1. When a transcript path is provided, the Transcript Reader shall read the file contents as UTF-8 text.
2. The Transcript Reader shall split the file into individual lines and filter out empty or whitespace-only lines.
3. If the transcript file does not exist, the Transcript Reader shall return an empty array of messages.
4. If the transcript file is empty, the Transcript Reader shall return an empty array of messages.

### Requirement 2: JSONL Entry Parsing

**Objective:** As a developer, I want each line of the transcript to be parsed and validated, so that only well-formed entries are processed and malformed data does not cause errors.

#### Acceptance Criteria

1. When a transcript line is read, the Transcript Reader shall parse it as JSON and validate it against the `transcriptEntrySchema` using Zod `safeParse`.
2. If a line contains malformed JSON, the Transcript Reader shall skip it and continue processing remaining lines.
3. If a line fails Zod schema validation, the Transcript Reader shall skip it and continue processing remaining lines.

### Requirement 3: Message Filtering

**Objective:** As a developer, I want only user and assistant messages to be extracted from transcripts, so that tool events, permission events, and other non-message entries are excluded from the conversation view.

#### Acceptance Criteria

1. The Transcript Reader shall process entries where the `type` field is "user" or "assistant".
2. The Transcript Reader shall also check the `message.role` field as a fallback when the `type` field is not present.
3. The Transcript Reader shall skip entries that are not user or assistant messages (e.g., tool_use, permission, system events).

### Requirement 4: Content Extraction

**Objective:** As a developer, I want message content to be extracted regardless of format, so that both simple string content and structured content-block arrays are handled correctly.

#### Acceptance Criteria

1. When message content is a string, the Transcript Reader shall trim whitespace and return it.
2. When message content is an array of content blocks, the Transcript Reader shall extract text from blocks with `type: "text"` and join them with newlines.
3. The Transcript Reader shall skip content blocks that are not of type "text" (e.g., tool_use, tool_result).
4. If extracted content is empty or whitespace-only after processing, the Transcript Reader shall skip the message.
5. The Transcript Reader shall preserve the original timestamp from the entry if present, or return null if absent.

### Requirement 5: Message Ordering

**Objective:** As a developer, I want messages to be returned in chronological order, so that the conversation view displays the correct sequence of interactions.

#### Acceptance Criteria

1. The Transcript Reader shall return messages in the same order they appear in the JSONL file (file order equals chronological order).

### Requirement 6: Conversation Rendering

**Objective:** As a developer, I want the conversation to be rendered in the session detail page with navigation controls, so that I can browse through the interaction history.

#### Acceptance Criteria

1. When transcript messages are available, the Session Detail Page shall render each message with its role (user/assistant) and content. Content is rendered via the `MessageContent` component which handles `MessageContentBlock[]` arrays (text blocks rendered as markdown, tool_use blocks rendered as compact indicators).
2. When no messages are available, the Session Detail Page shall display an empty state with guidance to send a prompt.
3. The Session Detail Page shall provide message navigation controls showing current position and total count.
4. The Session Detail Page shall support navigating to the previous and next message.
5. The Session Detail Page shall disable the previous button when at the first message and the next button when at the last message.
6. The Session Detail Page shall auto-scroll to the latest message when the message count changes.
