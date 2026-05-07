# pi-session-recap — one-line session context for Pi

A Pi extension that keeps a one-line recap above the editor so long-running coding sessions are easier to resume.

```bash
pi install npm:@lukemelnik/pi-session-recap
```

```text
/session-recap status
```

## Features

- **Recap widget** — show the current session focus directly above Pi's editor.
- **Idle refresh** — update the recap after agent turns once Pi is idle.
- **Model selection** — choose `auto`, the current active model, or a fixed `provider/model-id`.
- **Fallback summaries** — use local heuristics when no authenticated recap model is available.
- **Session persistence** — save the latest recap as extension state so resumed sessions and external monitors can read it.
- **Configurable delay** — refresh immediately or after delays such as `10s`, `30s`, `2m`, or `1h`.
- **Command autocomplete** — complete subcommands, delays, and authenticated model IDs.

## Install

Install from npm:

```bash
pi install npm:@lukemelnik/pi-session-recap
```

Install project-locally instead of globally:

```bash
pi install npm:@lukemelnik/pi-session-recap -l
```

Install from GitHub or a local checkout:

```bash
pi install git:github.com/lukemelnik/pi-session-recap
pi install /absolute/path/to/pi-session-recap
```

## Quick Start

Install the package, open Pi, then check the current recap configuration:

```text
/session-recap status
```

Use the default model selection and refresh delay:

```text
/session-recap model auto
/session-recap delay default
```

Regenerate the recap immediately from recent session context:

```text
/session-recap refresh
```

## Commands

| Command | Description |
|---------|-------------|
| `/session-recap` | Show current settings. Same as `/session-recap status`. |
| `/session-recap status` | Show whether the widget is enabled, the recap model, delay, and settings path. |
| `/session-recap on` | Show the recap widget and refresh after agent turns. |
| `/session-recap off` | Hide the recap widget and stop refreshes. |
| `/session-recap toggle` | Toggle the recap widget. |
| `/session-recap refresh` | Regenerate the recap immediately from recent context. |
| `/session-recap model` | Open a model picker for authenticated models. |
| `/session-recap model auto` | Use the first available recap candidate, then fall back to the current active model. |
| `/session-recap model current` | Always use the current active Pi model. |
| `/session-recap model <provider>/<model-id>` | Use a fixed model for recaps. |
| `/session-recap delay` | Show the current refresh delay. |
| `/session-recap delay <duration>` | Set the refresh delay. Supports `ms`, `s`, `m`, and `h`. |
| `/session-recap delay default` | Restore the default 30 second delay. |

## Model Behavior

The `auto` model mode tries these authenticated models first, then falls back to the active Pi model:

1. `openai-codex/gpt-5.4-mini`
2. `openai/gpt-5.4-mini`
3. `openrouter/openai/gpt-5.4-mini`

If no authenticated model is available, the extension generates a best-effort local fallback from recent user requests and file paths.

The selected recap model receives recent session text so it can summarize the actual task. Use `/session-recap off` if recap context should not be sent to a model provider.

## Configuration

Settings are stored globally at:

```text
~/.pi/agent/session-recap.json
```

| Setting | Default | Description |
|---------|---------|-------------|
| `enabled` | `true` | Whether the recap widget is shown. |
| `delayMs` | `30000` | Delay after an agent turn before refreshing. |
| `modelMode` | `auto` | One of `auto`, `current`, or `fixed`. |
| `provider` | unset | Provider used when `modelMode` is `fixed`. |
| `modelId` | unset | Model ID used when `modelMode` is `fixed`. |

Settings changes are also written into the current Pi session so resumed or forked sessions keep their recap choices.

## Session State

The latest generated recap is saved in the current Pi session as a custom extension entry:

```json
{
  "type": "custom",
  "customType": "session-synopsis-state",
  "data": {
    "schemaVersion": 1,
    "synopsis": "Debugging API integration failures in Songkeeper",
    "lastSummarizedLeafId": "abc123",
    "updatedAt": 1778165000000
  }
}
```

Pi custom entries are extension state and are not sent to the model as conversation context. Consumers should read the current branch from newest to oldest and use the first `session-synopsis-state` entry.

## Manage the Package

```bash
pi list
pi config
pi update npm:@lukemelnik/pi-session-recap
pi remove npm:@lukemelnik/pi-session-recap
```

If the package was installed project-locally, pass `-l` to `pi remove`:

```bash
pi remove npm:@lukemelnik/pi-session-recap -l
```

## Requirements

- Pi with package support.
- An authenticated model for generated recaps. Without one, local fallback summaries still work.

## Development

Maintainer setup, type checking, and release commands are documented in [docs/development.md](docs/development.md).

## License

MIT
