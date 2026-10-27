# ReRune for Figma

Link Figma text layers to [ReRune](https://rerune.io) translation keys, push copy as drafts and preview every language on the canvas.

- **Designers** link text layers to existing keys or create new keys from Figma. Edits arrive in ReRune as drafts of the main language. Nothing is ever published from Figma.
- **Preview** any project language (draft or published, with inheritance and variations) directly on the canvas, then reset to the original text.
- **Developers** see linked keys in Dev Mode and copy snippets for React (i18next), Flutter, Android, iOS and Angular.

No AI features run inside the plugin. Keys created from Figma count toward the ReRune plan's key limit.

## Requirements

- A ReRune account. Designers join free on every ReRune plan.
- Figma Design: a Full seat, or a Starter plan with edit access to the file.
- Dev Mode features need a paid Figma plan.

## Install

- **Community:** the Figma Community link will be added here once the plugin is published.
- **Development build:** see [Development](#development).

## Development

Requirements: Node 24 (see `.nvmrc`) and npm.

```bash
npm ci
npm run watch        # development build (localhost API and dashboard), rebuilds on change
```

Then in the Figma desktop app: **Plugins → Development → Import plugin from manifest…** and pick `manifest.json` in this folder.

The development build talks to a local ReRune server on `http://localhost:8080` and opens the dashboard on `http://localhost:3000`. The production build (`npm run build`) uses `https://rerune.io/api` and `https://rerune.io`.

| Script | What it does |
|---|---|
| `npm run build` | Production build (`manifest.json`, `build/main.js`, `build/ui.js`) |
| `npm run build:dev` | Development build; adds the "ReRune diagnostics" codegen language |
| `npm run watch` | Development build in watch mode |
| `npm run typecheck` | Type checks main thread, UI and tests with separate configs |
| `npm run lint` | ESLint, including Figma's plugin rules for main-thread code |
| `npm test` | Unit tests (vitest) |
| `npm run zip` | Production build packed as `rerune-figma-plugin.zip` |

Manual test steps live in `TESTING.md`.

## Build and release

`npm run zip` produces the release archive. Publishing happens manually in the Figma desktop app (2FA required) under the BasalBit/ReRune profile.

## Architecture

The plugin is built with [Create Figma Plugin](https://yuanqing.github.io/create-figma-plugin/) and Preact.

- `src/main` runs in Figma's main thread: canvas reads and writes, plugin data, `clientStorage`. It targets ES2017 and has no DOM types.
- `src/ui` runs in the plugin iframe: screens and every call to the ReRune API.
- `src/shared` holds pure, unit-tested logic used by both: message types, wire types, plugin-data parsing, hashing, key-name suggestions, sync state and the push plan.
- Main and UI talk only through typed messages (`src/shared/messages.ts`). A central policy (`src/shared/message-policy.ts`) blocks every write in Dev Mode.

Links live in shared plugin data (namespace `rerune`) on each text layer:

```json
{"v":1,"id":"<keyId>","k":"<keyName>","p":"<projectId>","src":"<hash>","nid":"<node id at link time>","t":1761550000000}
```

File settings live on the document and are mirrored to each page.

## Privacy

The plugin talks only to the ReRune API, and only when you act: it sends the texts you search for, link or push (with the frame name as the new key's description), and the IDs of the keys it shows. Sign-in pairs the plugin with your ReRune session in the browser; the plugin stores its token only in Figma's local plugin storage on your machine. See the [ReRune privacy policy](https://rerune.io/privacy).

## Licence

[MIT](LICENSE), Copyright (c) 2026 BasalBit.
