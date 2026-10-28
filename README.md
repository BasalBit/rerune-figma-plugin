# ReRune for Figma

Link Figma text layers to [ReRune](https://rerune.io) translation keys, push copy as drafts and preview every language on the canvas.

- **Designers** link text layers to existing keys or create new keys from Figma. Edits arrive in ReRune as drafts of the main language. Nothing is ever published from Figma.
- **Preview** any project language (draft or published, with inheritance and variations) directly on the canvas, then reset to the original text.
- **Context:** once the file's Figma link is saved, ReRune knows which layers show each key, and pushes can upload a screenshot of each changed frame. Translators see where a key is used in the dashboard's Design tab, and AI agents can ask ReRune's MCP server for the keys of a Figma frame.
- **Developers** see the linked keys of a selection in Dev Mode, with their values in every language, and copy snippets for React (i18next), Flutter, Android, iOS and Angular from the inspect panel or Dev Mode's Code section.

No AI features run inside the plugin. Keys created from Figma count toward the ReRune plan's key limit.

## Requirements

- A ReRune account. Designers join free on every ReRune plan.
- Figma Design: a Full seat, or a Starter plan with edit access to the file.
- Dev Mode features need a paid Figma plan.

## Install

- **Community:** the Figma Community link will be added here once the plugin is published.
- **Development build:** see [Development](#development).

## Using the plugin

1. **Sign in with ReRune.** The plugin shows a code and opens ReRune in your browser; check that the codes match and click Connect there. The plugin then shows "Signed in as {email}" (**Not me** signs out again). Figma desktop and browser Figma keep separate sign-ins.
2. **Choose a project** for the file and, optionally, paste the file's link (**Share → Copy link**). Everyone who opens the file with the plugin gets the same project.
3. **Layers:** scan the selection or the page, link layers to existing keys (search, or **Link exact matches** for texts that already exist in ReRune), or mark them to create new keys with a suggested name. Linked layers whose text is longer than the key's max length are marked **Over max length** (filter **Too long**).
4. **Push** sends new and changed texts to ReRune as drafts after a review of every change and conflict, and can update layers whose key changed in ReRune. A change longer than the key's max length is held back until it fits.
5. **Preview** shows a language on the canvas; **Reset** restores the original text and styles. Under **Sample values and plural forms** you give placeholders sample values (kept per project on your machine) and pick the plural form to show, from the categories of the language you preview. Values longer than their key's max length are listed after the preview.
6. **QA:** **Pseudo-localize** replaces the letters of every text layer in scope with accented look-alikes and makes it about 30–40% longer, to find text that clips before translations exist; Reset restores it like any preview.
7. **Settings:** key-name template and case style, scan options, "Upload screenshots on push", the file's Figma link, and Diagnostics (Advanced).

Plural and ICU values are rendered with the sample values: without a sample a placeholder shows as `[name]`, and a plural message shows the form you picked or, by default, its `other` form, with `#` as a count of that form (formatted for the language). Plural categories follow the CLDR rules of the language as the browser knows them; a regional language such as `de-AT` uses the rules of `de`, as ReRune does.

Once the file's Figma link is pasted (Project screen or Settings → Figma file), the plugin also keeps ReRune's list of which layer shows which key up to date, so the dashboard can show where a key is used: after every link, unlink and push, and on **Sync links on this page**. ReRune's link for a layer is removed only when the layer exists and shows no key or another key; links whose layer is not found are listed and removed only on request. Branch files and files that may be copies (their name differs from the one stored with the link) pause this until the link is confirmed, because they share layer IDs with the original file. Without the Edit keys permission links stay in the file only.

With **Upload screenshots on push** on (Settings → Push), a push ends by uploading an image of each top-level frame whose layers it changed, with a box for every linked layer in it. Main exports one frame per request (JPG, or PNG for frames without an opaque fill; at most 4096 px on the long side and 2 MB, exported smaller when needed) and computes the boxes; the UI checks the decoded size and uploads the frames one by one. Frames that show a language preview are skipped. Uploads run only when the ReRune server stores screenshots, the account is not a sandbox account, the file's link is confirmed (no branch, no suspected copy) and you can edit keys.

In Dev Mode the plugin is read-only. The inspect panel signs in like Figma Design does, then shows each linked key of the selection: its status, max length, its value in every project language (**Draft** or **Published**, with inherited and missing values marked), the snippet for the platform you pick (remembered on your machine) with **Copy code**, and **Open in ReRune**. Every time it loads values it refreshes the codegen cache. The Code section (Dev Mode → Code, one language per platform) never calls the network: it reads the links in the file and that cache, so a key renamed in ReRune shows its new name there after the inspect panel or a Figma Design session has loaded it. Keys the cache does not know yet get a snippet without placeholders and a note to open the inspect panel. A frame lists at most 50 keys ("More keys not shown").

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

Figma keys the plugin's local storage (sign-in, preferences) by the plugin ID in `package.json` → `figma-plugin.id`. The ID `1697181748239106841` was issued by Figma when the plugin was created; never change it, or every user is signed out and loses their preferences.

### Point it at a local ReRune

The development build always calls `http://localhost:8080` and opens the dashboard on `http://localhost:3000`. The manifest allows the local API only for imported development plugins (`devAllowedDomains`); other hosts are blocked by Figma.

1. **Server** (`rerune-server`): in `.env`, set `HASH_SECRET` and `FIGMA_CONNECT_URL=http://localhost:3000/figma/connect`, then `go run ./cmd/api`. Without `FIGMA_CONNECT_URL`, sign-in fails with "Sign-in with ReRune isn't available right now". The `/figma/` routes accept the plugin's `null` origin by themselves; never add `null` to `CORS_ALLOWED_ORIGINS`.
2. **Screenshots** (optional): set `DESIGN_STORAGE_ENABLED=true` and the other `DESIGN_STORAGE_*` values of a Bunny storage zone and pull zone (the server's `env_sample.txt` and `docs/runbooks/design-storage.md`). Without them the plugin works, but uploads nothing and hides "Upload screenshots on push".
3. **Dashboard** (`rerune-dashboard`): `pnpm dev`. It calls `http://localhost:8080` unless `NEXT_PUBLIC_API_URL` says otherwise. **Sign in with ReRune** opens `http://localhost:3000/figma/connect?code=…` there.
4. **Check the connection:** in the plugin, **Diagnostics** (on the Sign in screen, or Settings → Advanced → Diagnostics) → **Network check** should report status 200, `"cors": "ok"` and, with storage set up, `"screenshots_enabled": true`.

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

### Tests

Unit tests sit next to the code (`*.test.ts`). A few tests check the repository as a whole:

- `test/message-contract.test.ts`: every message type is sent by one side and handled by the other, each UI handles what main posts in its mode, and every request main receives gets exactly one answer.
- `test/dev-mode-policy.test.ts` and `src/ui/dev-mode-ui.test.ts`: Dev Mode refuses every write, the messages it accepts leave a file unchanged, codegen never writes or calls the network, and the Dev Mode UI never builds a message Dev Mode refuses.
- `test/docs.test.ts` and `src/ui/api/readme.test.ts`: this README and `TESTING.md` match the build, the screens and the endpoints the plugin calls.

Some of these read the sources through `import.meta.glob`. Vitest caches module graphs in `node_modules/.vitest-cache`; after adding or removing source files, run `rm -rf node_modules/.vitest-cache` (or `npm ci`) if a contract test reports a file list that looks stale.

Everything that depends on real Figma behaviour (sign-in, scans of large files, instances, preview restore, Dev Mode, link sync on branches and copies, screenshots, the spike questions) is tested by hand: see [`TESTING.md`](TESTING.md).

## Build and release

`npm run zip` produces the release archive. Publishing happens manually in the Figma desktop app (2FA required) under the BasalBit/ReRune profile.

## Architecture

The plugin is built with [Create Figma Plugin](https://yuanqing.github.io/create-figma-plugin/) and Preact.

- `src/main` runs in Figma's main thread: canvas reads and writes, plugin data, `clientStorage`, frame exports. It targets ES2017 and has no DOM types.
- `src/ui` runs in the plugin iframe: screens and every call to the ReRune API. `src/ui/api` is the fetch client and one function per endpoint, `src/ui/state` the framework-free screen logic (pairing poller, scans, push and preview orchestration, sample values, link sync, screenshot uploads, the inspect panel; unit-tested in node), `src/ui/screens` the Preact screens. `src/ui/app.tsx` renders the Design-mode app, or the Dev Mode inspect app (`src/ui/inspect-app.tsx`) in Dev Mode.
- `src/shared` holds pure, unit-tested logic used by both: message types, wire types, plugin-data parsing, hashing, key-name suggestions, Figma URL parsing, sync state, the push plan, ICU sample rendering and pseudo-localization.
- `src/codegen/snippets.ts` builds the code snippets for React (i18next), Flutter, Android, iOS and Angular. It is pure and shared by the Dev Mode Code section (main) and the inspect panel (UI).

### Messages

Main and UI talk only through typed messages (`src/shared/messages.ts`). Every UI → main message has an impact in `src/shared/message-policy.ts`, and the main bus checks it before any handler runs: Dev Mode accepts `ui` and `read` messages and refuses every `metadata` and `canvas` message (Figma shows "Not available in Dev Mode"). Each `metadata` or `canvas` message is one undo step. Main answers every request with its answer or a `handler-error`, so the UI never waits for its 30-second watchdog.

| UI → main | Impact | Dev Mode | Main answers |
|---|---|---|---|
| `ui-ready` | `ui` | yes | `init` |
| `auth-save` | `ui` | yes | — |
| `auth-clear` | `ui` | yes | — |
| `prefs-save` | `ui` | yes | — |
| `cache-save` | `ui` | yes | — |
| `open-external` | `ui` | yes | — |
| `notify` | `ui` | yes | — |
| `resize` | `ui` | yes | — |
| `select-nodes` | `read` | yes (zooms only) | — |
| `scan-request` | `read` | yes | `scan-progress`, `scan-batch`, then `scan-done` |
| `scan-cancel` | `read` | yes | — |
| `inspect-request` | `read` | yes | `inspect-selection` |
| `link-check` | `read` | yes | `link-check-result` |
| `screenshots-export` | `read` | yes | `frame-image` per frame, then `frame-images-done` |
| `diagnostics-read` | `read` | yes | `diagnostics-result` |
| `settings-save` | `metadata` | no | `op-result` |
| `link-apply` | `metadata` | no | `op-result` |
| `link-remove` | `metadata` | no | `op-result` |
| `text-apply` | `canvas` | no | `op-result` |
| `preview-apply` | `canvas` | no | `op-result` |
| `preview-reset` | `canvas` | no | `op-result` |
| `overflow-check` | `canvas` | no | `overflow-result` (Phase 3) |
| `language-copies` | `canvas` | no | `op-result` (Phase 3) |
| `diagnostics-write` | `canvas` | no | `diagnostics-result` |
| `diagnostics-devmode-probe` | `devprobe` | development builds only | `diagnostics-result` |

Main also sends `selection-changed` (Design mode) and `inspect-selection` (Dev Mode) when the selection or page changes, and `handler-error` for a refused or failed message. `link-check` / `link-check-result` (link sync reads layers with hidden instance children included; with `inheritors`, as after a link, unlink or push, main also answers for the current page's instance sublayers that inherit from a checked text inside a component), the frame skip reason `preview_active` and `inspect-selection`'s `truncated` (a selected frame has more than 50 linked layers; the panel lists each key's first layer first and says that more are not shown) are additions to the spec's message list.

### Data in the file

Everything the plugin stores in a file is shared plugin data in the namespace `rerune` (JSON strings, readable by every build of the plugin):

| Node | Key | Value |
|---|---|---|
| text layer | `link` | `{"v":1,"id":"<keyId>","k":"<keyName>","p":"<projectId>","src":"<hash>","nid":"<node id at link time>","t":1761550000000}`, or the tombstone `{"v":1,"none":true}` after an unlink that could not clear inherited data |
| text layer | `preview` | the original text and styles while a preview is shown, with the `nid` it was written on |
| text layer | `diag` | diagnostics marker (development tests only) |
| frame | `langCopy` | marks a per-language copy of a frame (Phase 3) |
| document and each page | `file` | the file's settings: ReRune server, project, the pasted Figma file link (file key, canonical URL, file name, branch key), key template and scan options |

`src` is a hash of the normalised text, so the plugin can tell which side changed. `nid` lets it recognise copied layers and layers inside instances. Linked layers also get Figma's relaunch button **Open ReRune** (relaunch data), which opens the plugin on them. The plugin writes plugin data only when you act (link, unlink, push, pull, preview, reset, saving settings, write diagnostics), never during a scan and never in Dev Mode.

### Data on your machine

Figma's local plugin storage (`clientStorage`, per plugin ID, separate for Figma desktop and browser Figma) holds:

| Key | Value |
|---|---|
| `rerune.auth.v1` | the sign-in per ReRune server: plugin token, its ID and expiry, your name and email |
| `rerune.prefs.v1` | preferences: last preview language, source and variation, "Upload screenshots on push", the inspect panel's platform, "Create one key for layers with identical text", and the sample values of each project's placeholders |
| `rerune.codegen.v1.<projectId>` | the codegen cache of one project: key name, placeholders and up to 60 characters of source text per key, at most 2,000 keys |
| `rerune.codegen.v1.index` | the projects with a codegen cache, at most 10 (the least recently used one is dropped) |

### ReRune API

The plugin calls only these endpoints of the ReRune API (`/api` on rerune.io), with the plugin token as `Authorization: Bearer` except where noted:

| Endpoint | Used for |
|---|---|
| `GET /figma/meta` | Network check and whether the server stores screenshots (no token) |
| `POST /figma/auth/sessions` | starting sign-in (no token) |
| `POST /figma/auth/sessions/{session_id}/poll` | waiting for the approval in the browser (no token) |
| `POST /figma/auth/logout` | Sign out and Not me |
| `GET /figma/projects` | the Project screen, and whether the account is a sandbox |
| `GET /figma/projects/{project_id}` | the file's project: languages, your permissions, a sample of its key names |
| `GET /figma/projects/{project_id}/keys/search` | searching keys in the Link dialog |
| `POST /figma/projects/{project_id}/keys/by-name` | exact name and text lookups (Link exact matches, push review) |
| `POST /figma/projects/{project_id}/keys/resolve` | sync state, preview values and the inspect panel's values |
| `POST /figma/projects/{project_id}/push` | Push |
| `PUT /figma/projects/{project_id}/files` | saving the file's Figma link |
| `PUT /figma/projects/{project_id}/links` | link sync: layers added, changed or removed |
| `GET /figma/projects/{project_id}/links` | Sync links on this page: ReRune's links of the page |
| `POST /figma/projects/{project_id}/screenshots` | uploading frame screenshots |

## Privacy

The plugin talks only to the ReRune API (the endpoints above), and only when you act: it sends the texts you search for, link or push (with the frame name as the new key's description), and the IDs of the keys it shows (the Dev Mode inspect panel loads the values of the selected layers' keys; the Code section sends nothing). When you paste the file's Figma link, it also sends the file's key, link and name, and for linked layers their layer IDs and the layer, frame and page names. With **Upload screenshots on push** on, a push also uploads an image of each frame it changed, with the frame and page names and the positions of the linked layers; ReRune stores these images in its EU image storage. Sandbox accounts never upload images. Sign-in pairs the plugin with your ReRune session in the browser; the plugin stores its token only in Figma's local plugin storage on your machine and sends it only to the ReRune API. See the [ReRune privacy policy](https://rerune.io/privacy).

## Licence

[MIT](LICENSE), Copyright (c) 2026 BasalBit.
