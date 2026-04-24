# pi-session-recap

A Pi extension that keeps a one-line recap widget above the editor so you can quickly remember what the current session has been about.

Features:
- Generates a short recap from recent session context
- Falls back to heuristics when no summarization model is available
- Adds `/session-recap on|off|toggle|status|refresh|model|delay`
- Lets you choose the recap model (`auto`, `current`, or a fixed `provider/model-id`)
- Lets you tune how long Pi waits after an agent turn before refreshing the recap

Install locally:
- `pi install /path/to/pi-session-recap`

Install from GitHub:
- `pi install git:github.com/lukemelnik/pi-session-recap`

After publishing:
- `pi install npm:@lukemelnik/pi-session-recap`

Usage:
- `/session-recap` — show whether recaps are enabled, the configured model, and the delay
- `/session-recap on` / `/session-recap off` — show or hide the recap widget
- `/session-recap model` — open a model picker for authenticated models
- `/session-recap model auto` — use the first available cheap recap model, then fall back to the active model
- `/session-recap model current` — always use the active model
- `/session-recap model openai/gpt-5.4-mini` — use a fixed model
- `/session-recap delay 2m` — wait two minutes after each agent turn before refreshing
- `/session-recap delay default` — restore the default 30 second delay
- `/session-recap refresh` — regenerate the recap immediately from recent context

Argument autocomplete suggests subcommands, common delays, `auto`/`current`, and authenticated `provider/model-id` values for model selection.

Settings are stored in `~/.pi/agent/session-recap.json`.

Release:
- `npm run release:patch` or `npm run release:minor` or `npm run release:major`
- `git push origin HEAD --follow-tags`
- `npm run publish:release`

`npm version` is the source of truth for releases here: it updates `package.json`, updates `package-lock.json`, creates a release commit, and creates a `vX.Y.Z` git tag.

No build step is required. Pi loads `src/index.ts` directly.
