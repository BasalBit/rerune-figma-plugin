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

Requirements: Node 24 (see `.nvmrc`), npm, and the Figma desktop app (macOS or Windows). Plugins in development are imported in the desktop app.

### Build

```bash
npm ci
npm run build:dev    # development build: manifest.json and build/
npm run watch        # the same, rebuilding on every change
```

| Build | Command | ReRune API | Dashboard (sign-in page) |
|---|---|---|---|
| Development | `npm run build:dev`, `npm run watch` | `http://localhost:8080` | `http://localhost:3000` |
| Production | `npm run build`, `npm run zip` | `https://rerune.io/api` | `https://rerune.io` |

`RERUNE_ENV` picks the build (`production` by default, or `development`); any other value fails the build. The development build adds the "ReRune diagnostics" codegen language. Both builds write the same `manifest.json` (not committed), so run `npm run build:dev` again after a production build before testing locally.

### Import the development build into Figma

1. Figma desktop → **Plugins → Development → Import plugin from manifest…** → pick `manifest.json` in this folder.
2. Run it from **Plugins → Development → ReRune** in Figma Design. In Dev Mode it is in the inspect panel's plugins, and its languages are in the Code section's language dropdown.
3. After a rebuild, run it again (⌥⌘P on macOS, Ctrl+Alt+P on Windows) or turn on **Plugins → Development → Hot reload plugin**.

Figma keys the plugin's local storage (sign-in, preferences) by the plugin ID in `package.json` → `figma-plugin.id`. It is a placeholder until the plugin is created in Figma; `TESTING.md` §0.1 explains how to get the real ID.

### Point it at a local ReRune

The development build always calls `http://localhost:8080` and opens the dashboard on `http://localhost:3000`. The manifest allows the local API only for imported development plugins (`devAllowedDomains`); other hosts are blocked by Figma.

1. **Server** (`rerune-server`): in `.env`, set `HASH_SECRET` and `FIGMA_CONNECT_URL=http://localhost:3000/figma/connect`, then `go run ./cmd/api`. Without `FIGMA_CONNECT_URL`, sign-in fails with "Sign-in with ReRune isn't available right now". The `/figma/` routes accept the plugin's `null` origin by themselves; never add `null` to `CORS_ALLOWED_ORIGINS`.
2. **Dashboard** (`rerune-dashboard`): `pnpm dev`. It calls `http://localhost:8080` unless `NEXT_PUBLIC_API_URL` says otherwise. **Sign in with ReRune** opens `http://localhost:3000/figma/connect?code=…` there.
3. **Check the connection:** in the plugin, **Diagnostics** (on the Sign in screen, or Settings → Advanced → Diagnostics) → **Network check** should report status 200 and `"cors": "ok"`.

### Scripts

| Script | What it does |
|---|---|
| `npm run build` | Production build (`manifest.json`, `build/main.js`, `build/ui.js`) |
| `npm run build:dev` | Development build; adds the "ReRune diagnostics" codegen language |
| `npm run watch` | Development build in watch mode |
| `npm run typecheck` | Type checks main thread, UI and tests with separate configs |
| `npm run lint` | ESLint, including Figma's plugin rules for main-thread code |
| `npm test` | Unit tests (vitest, node environment, with a fake `figma` global in `test/figma-mock.ts`) |
| `npm run zip` | Production build packed as `rerune-figma-plugin.zip` |

Everything that depends on real Figma behaviour (sign-in, scans of large files, instances, preview restore, Dev Mode, the spike questions) is tested by hand: see [`TESTING.md`](TESTING.md).

## Build and release

`npm run zip` produces the release archive. Publishing happens manually in the Figma desktop app (2FA required) under the BasalBit/ReRune profile.

## Architecture

The plugin is built with [Create Figma Plugin](https://yuanqing.github.io/create-figma-plugin/) and Preact.

- `src/main` runs in Figma's main thread: canvas reads and writes, plugin data, `clientStorage`. It targets ES2017 and has no DOM types.
- `src/ui` runs in the plugin iframe: screens and every call to the ReRune API. `src/ui/api` is the fetch client and one function per endpoint, `src/ui/state` the framework-free screen logic (pairing poller, scans, push and preview orchestration, unit-tested in node), `src/ui/screens` the Preact screens.
- `src/shared` holds pure, unit-tested logic used by both: message types, wire types, plugin-data parsing, hashing, key-name suggestions, sync state and the push plan.
- Main and UI talk only through typed messages (`src/shared/messages.ts`). A central policy (`src/shared/message-policy.ts`) blocks every write in Dev Mode. `test/message-contract.test.ts` checks that every message type is sent by one side and handled by the other.

Everything the plugin stores in a file is shared plugin data in the namespace `rerune` (JSON strings, readable by every build of the plugin):

| Node | Key | Value |
|---|---|---|
| text layer | `link` | `{"v":1,"id":"<keyId>","k":"<keyName>","p":"<projectId>","src":"<hash>","nid":"<node id at link time>","t":1761550000000}`, or the tombstone `{"v":1,"none":true}` after an unlink that could not clear inherited data |
| text layer | `preview` | the original text and styles while a preview is shown, with the `nid` it was written on |
| text layer | `diag` | diagnostics marker (development tests only) |
| frame | `langCopy` | marks a per-language copy of a frame (Phase 3) |
| document and each page | `file` | the file's settings: ReRune server, project, the pasted Figma file link (file key, canonical URL, file name, branch key), key template and scan options |

`src` is a hash of the normalised text, so the plugin can tell which side changed. `nid` lets it recognise copied layers and layers inside instances. Sign-in, preferences and the Dev Mode codegen cache live in Figma's local plugin storage on your machine, not in the file.

Once the file's Figma link is pasted (Project screen or Settings → Figma file), the plugin also keeps ReRune's list of which layer shows which key up to date, so the dashboard can show where a key is used: after every link, unlink and push, and on **Sync links on this page**. ReRune's link for a layer is removed only when the layer exists and shows no key or another key; links whose layer is not found are listed and removed only on request. Branch files and files that may be copies (their name differs from the one stored with the link) pause this until the link is confirmed, because they share layer IDs with the original file.

With **Upload screenshots on push** on (Settings → Push), a push ends by uploading an image of each top-level frame whose layers it changed, with a box for every linked layer in it. Main exports one frame per request (JPG, or PNG for frames without an opaque fill; at most 4096 px on the long side and 2 MB, exported smaller when needed) and computes the boxes; the UI checks the decoded size and uploads the frames one by one. Frames that show a language preview are skipped. Uploads run only when the ReRune server stores screenshots, the account is not a sandbox account, the file's link is confirmed (no branch, no suspected copy) and you can edit keys.

## Privacy

The plugin talks only to the ReRune API, and only when you act: it sends the texts you search for, link or push (with the frame name as the new key's description), and the IDs of the keys it shows. When you paste the file's Figma link, it also sends the file's key, link and name, and for linked layers their layer IDs and the layer, frame and page names. With **Upload screenshots on push** on, a push also uploads an image of each frame it changed, with the frame and page names and the positions of the linked layers; ReRune stores these images in its EU image storage. Sandbox accounts never upload images. Sign-in pairs the plugin with your ReRune session in the browser; the plugin stores its token only in Figma's local plugin storage on your machine. See the [ReRune privacy policy](https://rerune.io/privacy).

## Licence

[MIT](LICENSE), Copyright (c) 2026 BasalBit.
