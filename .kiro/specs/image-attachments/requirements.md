# Requirements Document

## Introduction

CC (Command Center) currently supports text-only prompts. This feature adds the ability to attach images to prompts sent to Claude Code sessions, enabling users to share visual context (screenshots, diagrams, UI mockups) alongside text instructions. Images can be attached via clipboard paste (Ctrl+V) or a file picker button, mirroring the Claude Code CLI experience.

## Requirements

### Requirement 1: Clipboard Image Paste

**Objective:** As a developer, I want to paste images from my clipboard into the prompt input area, so that I can quickly share screenshots and visual context with Claude without leaving the keyboard.

#### Acceptance Criteria

1. When the user presses Ctrl+V with an image on the clipboard while the prompt textarea is focused, CC shall extract the image data from the clipboard and attach it to the current prompt as a pending image attachment.
2. When an image is pasted from the clipboard, CC shall display a thumbnail preview of the attached image below the prompt textarea so the user can verify the correct image was captured.
3. When the user pastes text from the clipboard (not an image), CC shall insert the text into the textarea as normal without creating an image attachment.
4. When multiple images are pasted sequentially, CC shall accumulate all images as separate attachments on the current prompt.

### Requirement 2: File Picker Image Attachment

**Objective:** As a developer, I want to attach image files from disk via a file picker button, so that I can send saved screenshots, diagrams, or design files to Claude.

#### Acceptance Criteria

1. CC shall display a file attachment button in the prompt input area that opens a native file picker dialog.
2. When the user selects one or more image files via the file picker, CC shall attach them to the current prompt and display thumbnail previews for each.
3. The file picker shall filter to accepted image formats only (JPEG, PNG, GIF, WebP).
4. When the user selects a non-image file or a file exceeding the maximum size, CC shall display an error message and not attach the file.

### Requirement 3: Image Attachment Management

**Objective:** As a developer, I want to review and remove image attachments before sending, so that I can correct mistakes without restarting the prompt.

#### Acceptance Criteria

1. While one or more images are attached, CC shall display an attachment preview area showing thumbnails of all pending images.
2. When the user clicks a remove/dismiss control on an image thumbnail, CC shall remove that image from the pending attachments.
3. When the user submits a prompt, CC shall clear all pending image attachments from the input area.
4. When the user clears the prompt input (e.g., pressing Escape), CC shall also clear all pending image attachments.

### Requirement 4: Image Transmission to Claude

**Objective:** As a developer, I want images to be sent along with my text prompt to the Claude Agent SDK, so that Claude can analyze and respond to the visual content.

#### Acceptance Criteria

1. When a prompt with image attachments is submitted, CC shall encode each image as a base64 data URL and include it in the prompt payload sent to the API route.
2. When the API route receives a prompt with image attachments, CC shall convert the attachments into the format expected by the Claude Agent SDK `query()` function and pass them alongside the text prompt.
3. When a prompt is submitted with images but no text, CC shall send the images as the sole prompt content without requiring text.
4. If an image attachment fails to encode or transmit, CC shall display an error message to the user and not submit the prompt.

### Requirement 5: Image Display in Conversation History

**Objective:** As a developer, I want to see the images I sent displayed in the conversation transcript, so that I can review what visual context was provided to Claude.

#### Acceptance Criteria

1. When a user message containing image attachments is stored in the transcript, CC shall persist image reference data (type, media type, and a displayable representation) in the transcript entry.
2. When rendering a user message that contains image content blocks, CC shall display the images inline within the message bubble alongside any text content.
3. While viewing conversation history, CC shall render previously sent images from transcript data so they remain visible across page reloads.

### Requirement 6: Image Validation and Constraints

**Objective:** As a developer, I want clear constraints on image attachments, so that the system behaves predictably and avoids sending excessively large payloads.

#### Acceptance Criteria

1. CC shall accept images in JPEG, PNG, GIF, and WebP formats only.
2. CC shall enforce a maximum file size per image (5 MB) and reject images exceeding this limit with a user-visible error.
3. CC shall enforce a maximum number of images per prompt (5 images) and prevent attaching additional images once the limit is reached.
4. If an image cannot be read or decoded, CC shall display a descriptive error message and discard the invalid attachment.
