# PROMPT.md Implementation Plan

## Overview

Seven UI improvements to the session detail page and project dashboard. Items are ordered by dependency — markdown rendering (item 4) is tackled early since it affects message display for several other items.

---

## Task 1: Optimistic user message display (PROMPT.md #1 + #2)

**What:** After submitting a prompt, immediately append the user's message to the conversation pane and clear the textarea — don't wait for `router.refresh()` to show it.

**Files:**
- `src/app/projects/[name]/[session]/SessionDetailPage.tsx`

**Changes:**
- Add `localMessages` state: `useState<TranscriptMessage[]>([])` for optimistic messages not yet in server state.
- In `handleSendPrompt`, before the fetch call:
  - Append `{ role: "user", content: promptText.trim(), timestamp: new Date().toISOString() }` to `localMessages`.
  - Clear `promptText` immediately (moved from the `res.ok` block).
- Compute `allMessages = [...messages, ...localMessages]` for rendering.
- When `messages` prop changes (server refresh), clear `localMessages` that are now in the server data. Use a `useEffect` that compares `messages.length` and resets `localMessages` to `[]`.
- Auto-scroll to the newly appended message.

**Note:** Item #2 (clear textarea on submit) is already implemented for the success case. This change moves the clear to happen *before* the fetch for immediate feedback.

---

## Task 2: Remove blockquote style from Claude responses (PROMPT.md #3)

**What:** Remove the left-border "blockquote" look on assistant messages.

**Files:**
- `src/app/globals.css`

**Changes:**
- Remove or comment out the `.message.assistant .message-content` rule (lines 1541-1544) that adds `padding-left` and `border-left: 2px solid`.
- Claude messages will render flush like user messages, differentiated only by the cyan "CLAUDE" label.

---

## Task 3: Markdown rendering with code highlighting (PROMPT.md #4)

**What:** Render messages as Markdown with syntax-highlighted code blocks.

**Dependencies:** `react-markdown`, `remark-gfm`, `rehype-highlight`, `highlight.js`

**Files:**
- `package.json` — add dependencies
- `src/app/projects/[name]/[session]/SessionDetailPage.tsx` — create `MessageContent` component
- `src/app/globals.css` — add highlight.js theme styles (or import a dark theme)

**Changes:**

1. **Install packages:**
   ```
   npm install react-markdown remark-gfm rehype-highlight highlight.js
   ```

2. **Create `MessageContent` component** (inline in SessionDetailPage or as a separate file `src/app/projects/[name]/[session]/MessageContent.tsx`):
   ```tsx
   import ReactMarkdown from "react-markdown";
   import remarkGfm from "remark-gfm";
   import rehypeHighlight from "rehype-highlight";

   function MessageContent({ content }: { content: string }) {
     return (
       <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
         {content}
       </ReactMarkdown>
     );
   }
   ```

3. **Replace** `<div className="message-content">{msg.content}</div>` with `<div className="message-content"><MessageContent content={msg.content} /></div>`.

4. **Import a highlight.js dark theme** in `globals.css` — use `github-dark` or similar dark theme that matches the app's palette. Add CSS rules for `.hljs` classes, or import from `highlight.js/styles/github-dark.css` in the component.

5. **Add markdown element styles** to globals.css for elements rendered by react-markdown: `h1`-`h6`, `ul`, `ol`, `li`, `blockquote`, `table`, `a`, `hr`, `p` — all scoped under `.message-content`.

---

## Task 4: Redesign pending Claude indicator (PROMPT.md #7)

**What:** Replace the cyan banner at the top of the conversation with a chatbot-style typing indicator positioned *after* the last user message, where Claude's response will appear.

**Files:**
- `src/app/projects/[name]/[session]/SessionDetailPage.tsx`
- `src/app/globals.css`

**Changes:**

1. **Remove** the `running-indicator` div from the top of `panel-body` (lines 315-320).

2. **Add a skeleton/typing indicator** after the last message in the `.conversation` div, conditionally rendered when `displayStatus === "running"`:
   ```tsx
   {displayStatus === "running" && (
     <div className="message assistant">
       <div className="message-role">Claude</div>
       <div className="message-content typing-indicator">
         <span className="typing-dot" />
         <span className="typing-dot" />
         <span className="typing-dot" />
       </div>
     </div>
   )}
   ```

3. **Add CSS** for `.typing-indicator` — three animated dots with staggered bounce animation:
   ```css
   .typing-indicator {
     display: flex;
     align-items: center;
     gap: 4px;
     padding: 8px 0;
   }
   .typing-dot {
     width: 6px;
     height: 6px;
     border-radius: 50%;
     background: var(--cyan);
     opacity: 0.4;
     animation: typingBounce 1.4s infinite ease-in-out;
   }
   .typing-dot:nth-child(2) { animation-delay: 0.2s; }
   .typing-dot:nth-child(3) { animation-delay: 0.4s; }
   ```

4. **Auto-scroll** to this indicator when it appears (it will be the last element in the conversation).

---

## Task 5: Project dashboard — visual distinction for projects with sessions (PROMPT.md #5)

**What:** Make it easy to see which projects have sessions vs. those with none.

**Files:**
- `src/app/projects/ProjectCard.tsx`
- `src/app/globals.css`

**Changes:**

- Projects with `activeSessions > 0` get a subtle visual boost:
  - Add a cyan left-border accent (3px) to the card: `.project-card.has-sessions { border-left: 3px solid var(--cyan-dim); }`
  - The session count stat value gets cyan color when > 0.
- Projects with `activeSessions === 0` remain with default subdued styling (lower opacity on the sessions stat).
- Add the `has-sessions` class conditionally in `ProjectCard.tsx` based on `project.activeSessions > 0`.

---

## Task 6: Prompt submit button alignment (PROMPT.md #6)

**What:** Fix the send button alignment so it sits flush with the bottom of the textarea.

**Files:**
- `src/app/globals.css`

**Changes:**
- The `.prompt-input-wrapper` already has `align-items: flex-end` (line 1624), which should bottom-align the button. The issue is likely that the button height (48px) doesn't match the textarea min-height (48px) or that the textarea's padding causes misalignment.
- Ensure `.send-btn` has `align-self: flex-end` and matches the textarea's visual bottom.
- May need to adjust the button to be `align-self: stretch` so it fills the height of the wrapper, or reduce the button to match the textarea's visible height.
- Verify visually in the browser and tweak padding/sizing as needed.

---

## Implementation Order

1. **Task 2** — Remove blockquote (CSS-only, 1 min)
2. **Task 3** — Markdown + code highlighting (install deps + component, most effort)
3. **Task 1** — Optimistic message display (state management change)
4. **Task 4** — Typing indicator (depends on Task 1 for correct positioning after optimistic message)
5. **Task 5** — Dashboard session distinction (independent)
6. **Task 6** — Button alignment (independent, visual polish)

Verify each task in the browser after implementation.
