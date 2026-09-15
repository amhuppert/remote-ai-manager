# Selections spanning blocks

## Behavior

Selecting text across paragraphs, headings, lists, or code offers the same Comment and Clip actions as selecting one paragraph. One comment covers the full passage. Transcript selections may also span messages; each selected excerpt retains its own message reference in one notepad append.

An annotation stays within its owning document, SDD element, or notepad. Transcript capture stays within one conversation surface and requires durable source identities for every crossed message.

## Anchor and rendering

The shared comment anchor identifies the starting block by source line and section. An optional `endBlock` identifies the final block when a passage spans blocks. Character offsets address the annotatable text between those blocks, with two newlines between consecutive block runs. The full selected quote is stored once.

A DOM text walk preserves document order and attributes each text node to its nearest source-stamped block. It excludes non-annotatable controls and avoids counting nested list text twice. The same text model captures selections, resolves saved anchors, and constructs highlight ranges. The first block remains the focus-restoration and gutter location.

Each annotation host owns its CSS highlight entries. A pinned Recogito patch scopes registry names and cleanup to the host so resizing or closing one section preserves annotations in other sections.

Resolution matches the complete quote within the bounded source span. Missing blocks, changed passage text, or ambiguous matches remain stale. Mouse and keyboard selections use the same path, including selection endpoints expressed as element boundaries.

## Source-specific adapters

- Document and notepad comments persist the optional endpoint alongside existing anchor columns. The schema floor adds the nullable endpoint columns idempotently.
- Native SDD prose uses the shared renderer. Review-mode resolution projects Markdown source into the same rendered text coordinates.
- Notepad comments map rendered selection endpoints into canonical source coordinates. Persistence retains the actual source passage, including source separators; highlighting projects it back to rendered coordinates. Reference/image chips retain their exclusion rules.
- Transcript capture intersects the range with each eligible message body, excludes surrounding message controls, and builds one attributed fragment per selected message. The landing pipeline appends the combined capture once. A selection is fenced as code only when its whole range lies inside one code region.

## Verification

Behavior tests cover partial first/last blocks, block separators, nested content, keyboard/element-boundary selections, protected content, persistence round trips, reload/re-anchoring, stale middle text, and conversation provenance. Browser checks exercise the shared annotation renderer and transcript capture at desktop and narrow widths.
