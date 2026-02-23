# Implementation Plan

- [x] 1. Extend schemas and types for image support
- [x] 1.1 Add the image content block variant to the message content block discriminated union so that transcripts and rendering can handle image data
  - Add an image variant with type, mediaType, and base64Data fields to the existing content block schema
  - Export the new image payload schema with mediaType enum (JPEG, PNG, GIF, WebP) and base64Data string
  - _Requirements: 5.1, 5.2, 6.1_

- [x] 1.2 Extend the prompt request schema to accept optional image attachments alongside text
  - Change the prompt field from required non-empty to allow empty strings
  - Add an optional images array field (max 5 items) using the image payload schema
  - Add a refinement that requires either non-empty prompt text or at least one image
  - _Requirements: 4.1, 4.3, 6.3_

- [x] 2. (P) Add server-side image-to-SDK conversion and transcript recording
- [x] 2.1 (P) Extend the prompt execution function to accept images and construct multi-modal SDK messages
  - Add an optional images parameter to the executePromptStream function signature
  - When images are present, build an async generator that yields a single user message with image and text content blocks in the format the Claude Agent SDK expects
  - When no images are present, continue passing the prompt as a plain string (preserve existing behavior)
  - Record image content blocks alongside text in the transcript entry for the user message
  - _Requirements: 4.2, 5.1_

- [x] 2.2 (P) Update both prompt API routes to parse and forward image data
  - Update the conversation-level prompt route to extract images from the validated request body and pass them to the execution function
  - Update the session-level prompt route identically
  - Update the error message for invalid requests to reflect that either text or images are accepted
  - _Requirements: 4.2_

- [x] 3. (P) Create the image attachment management hook with validation
- [x] 3.1 (P) Implement the useImageAttachments hook that manages pending image state, validates constraints, and converts files to base64
  - Maintain a pending images array in React state with entries containing a unique ID, filename, MIME type, base64 data, preview object URL, and file size
  - Implement addImage that accepts a File or Blob, validates the MIME type against the accepted formats whitelist, checks the file size against the 5 MB limit, checks the image count against the 5-per-prompt limit, reads the file as base64, and returns an error string on failure or null on success
  - Implement removeImage (by ID, revoke the object URL), clearImages (revoke all object URLs), and an isAtLimit flag
  - Clean up all object URLs on unmount
  - _Requirements: 1.1, 1.4, 2.2, 2.4, 3.1, 3.2, 3.3, 3.4, 6.1, 6.2, 6.3, 6.4_

- [x] 4. (P) Extend transport hooks and store for image-aware prompts
- [x] 4.1 (P) Update the Zustand store to carry full user content blocks in optimistic messages
  - Change submitPrompt to accept a userContent array of content blocks instead of a text string, and use it directly as the optimistic user message content
  - Change receiveStreamContent to accept a userContent array and use it for the optimistic user message, so images remain visible while assistant content streams in
  - Update all existing callers of these store actions to construct the content array (text-only for backward compatibility when no images)
  - _Requirements: 5.2_

- [x] 4.2 (P) Extend the send prompt hook to include images in the request payload and support image-only submissions
  - Add an optional images parameter (array of mediaType + base64Data) to the hook's return function signature
  - Include the images array in the JSON body sent to the API route
  - Allow submission when text is empty but images are present (bypass the empty-text early return)
  - Pass the full user content blocks (text + images) to the store's submitPrompt and receiveStreamContent actions
  - _Requirements: 4.1, 4.3, 4.4_

- [x] 5. (P) Render images in conversation message bubbles
- [x] 5.1 (P) Add image block rendering to the message content component and style inline images
  - Handle the image content block type in the rendering loop: render an img element using a data URL constructed from the mediaType and base64Data fields
  - Add CSS for inline message images: constrained max-width and max-height, border radius, and vertical margin
  - Ensure images from transcript history render correctly on page reload (same code path as live messages)
  - _Requirements: 5.2, 5.3_

- [x] 6. Integrate image attachment UI into the session prompt input area
- [x] 6.1 Create the attachment preview strip component that shows thumbnails with remove controls
  - Build a horizontal strip that renders a small thumbnail for each pending image using the preview object URL
  - Add a dismiss button on each thumbnail that calls the remove callback
  - Show the strip only when there are pending images, positioned between the textarea and the actions bar
  - Add CSS for the preview strip: horizontal flex layout, fixed-size thumbnails with object-fit cover, and an absolute-positioned remove button
  - _Requirements: 1.2, 3.1, 3.2_

- [x] 6.2 Wire clipboard paste handling into the prompt textarea
  - Add an onPaste handler to the textarea that inspects clipboard data items for image entries
  - For each image item, extract the file and call the attachment hook's addImage function; if it returns an error, display it via the existing prompt error mechanism
  - When an image is found, prevent the default paste behavior; when only text is present, let the default behavior proceed
  - _Requirements: 1.1, 1.2, 1.3, 1.4_

- [x] 6.3 Add a file picker button for attaching images from disk
  - Add a hidden file input element that accepts JPEG, PNG, GIF, and WebP formats with multiple selection enabled
  - Add a visible attachment button in the prompt actions bar that triggers the hidden file input
  - On file selection, iterate the selected files and call addImage for each; display errors via the existing prompt error mechanism
  - _Requirements: 2.1, 2.2, 2.3, 2.4_

- [x] 6.4 Update prompt submission and input clearing to handle image attachments
  - Modify the send prompt handler to construct a full user content array from the current text and pending images, pass images to the send prompt hook, and clear images after submission
  - Update the Escape key handler to also clear pending images alongside clearing the text
  - Adjust the send button disabled condition to allow sending when images are present even if text is empty
  - _Requirements: 3.3, 3.4, 4.1, 4.3_

- [x] 7. Add Storybook stories for visual review of image attachment components
- [x] 7.1 (P) Create stories for the attachment preview strip component
  - Story with a single image thumbnail
  - Story with multiple images (up to the limit)
  - Story demonstrating the remove interaction
  - _Requirements: 1.2, 3.1, 3.2_

- [x] 7.2 (P) Create stories for the message content component with image blocks
  - Story with a text-only message (existing behavior)
  - Story with an image-only message
  - Story with mixed text and image content blocks
  - _Requirements: 5.2, 5.3_
