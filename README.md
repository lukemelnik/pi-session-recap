# pi-session-recap

A Pi extension that keeps a one-line recap widget above the editor so you can quickly remember what the current session has been about.

Features:
- Generates a short recap from recent session context
- Falls back to heuristics when no summarization model is available
- Adds `/summary on|off|toggle|status`

Install locally:
- `pi install ~/projects/pi-extensions/session-recap`

After publishing:
- `pi install npm:@lukemelnik/pi-session-recap`

Release:
- `npm run release:patch` or `npm run release:minor` or `npm run release:major`
- `git push origin HEAD --follow-tags`
- `npm run publish:release`

`npm version` is the source of truth for releases here: it updates `package.json`, updates `package-lock.json`, creates a release commit, and creates a `vX.Y.Z` git tag.

No build step is required. Pi loads `src/index.ts` directly.
