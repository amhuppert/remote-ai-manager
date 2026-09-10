# Checkpoint configuration verification

Global Configuration → Compaction exposes the shared checkpoint/conversation-artifact backend, model, and reasoning selection. Oversized-message generation has its own model selection. Project overrides retain precedence.

- Live dev page: saved Codex GPT-5.4 Mini with Medium reasoning through the UI (HTTP 200); a fresh GET returned the exact selection. Restored the original compaction settings and verified equality after restoration.
- Keyboard: selected reasoning with ArrowDown and Enter; dismissed the mobile listbox with Escape.
- Inspected desktop at 1440 × 900 and mobile at 390 × 844, including the expanded reasoning menu. No horizontal overflow or clipped dropdown content.
- Regression tests cover saving reasoning without a separate Apply, preserving explicit empty model parameter maps, and real config API/file persistence through checkpoint generation. Generation tests substitute provider responses; no paid model call was made for this UI change.

Screenshots: [desktop](desktop.jpg), [mobile](mobile.jpg), [mobile reasoning menu](mobile-reasoning.jpg).
