# Development

This repository is a Pi package for the `pi-session-recap` extension.

## Requirements

- Node.js with npm.
- Pi installed locally for manual extension testing.
- A configured Pi model provider when testing generated recaps. Local fallback summaries work without model auth.

## Setup

Install dependencies:

```bash
npm install
```

Run the TypeScript check:

```bash
npm run check
```

Install the checkout into Pi for manual testing:

```bash
pi install /absolute/path/to/pi-session-recap
```

Remove the local install when finished:

```bash
pi remove /absolute/path/to/pi-session-recap
```

## Package Structure

- `src/index.ts` — Pi extension entry point.
- `package.json` — npm metadata and the Pi package manifest.
- `README.md` — user-facing install and command documentation.
- `docs/` — maintainer and development documentation.

The Pi manifest is:

```json
{
  "pi": {
    "extensions": ["./src/index.ts"]
  }
}
```

## Build and Check

There is no build output. Pi loads `src/index.ts` directly from the installed package.

The only required local validation step is:

```bash
npm run check
```

That script runs:

```bash
tsc --noEmit -p tsconfig.json
```

Runtime Pi packages are listed as `peerDependencies`; local type checking uses matching `devDependencies`.

## Release

Use `npm version` through the release scripts. It updates `package.json`, updates `package-lock.json`, creates a release commit, and creates a `vX.Y.Z` git tag.

Choose the semver bump:

```bash
npm run release:patch
npm run release:minor
npm run release:major
```

Push the release commit and tag:

```bash
git push origin HEAD --follow-tags
```

Publish to npm:

```bash
npm run publish:release
```

`prepublishOnly` runs `npm run check` before publishing.

## Verify Published Installs

Install from npm in Pi:

```bash
pi install npm:@lukemelnik/pi-session-recap
```

Install from GitHub in Pi:

```bash
pi install git:github.com/lukemelnik/pi-session-recap
```
