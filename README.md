# pi-session-recap

A Pi extension that keeps a one-line recap widget above the editor so you can quickly remember what the current session has been about.

Features:
- Generates a short recap from recent session context
- Falls back to heuristics when no summarization model is available
- Adds `/summary on|off|toggle|status`

Install locally:
- `pi install ~/projects/pi-extensions/session-recap`

Later, after publishing:
- `pi install npm:pi-session-recap`

No build step is required. Pi loads `src/index.ts` directly.
