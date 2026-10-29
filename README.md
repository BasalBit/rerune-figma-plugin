# ReRune for Figma

Link Figma text layers to [ReRune](https://rerune.io) translation keys, push copy as drafts and preview every language on the canvas.

- **Designers** link text layers to existing keys or create new keys from Figma. Edits arrive in ReRune as drafts of the main language. Nothing is ever published from Figma.
- **Preview** any project language (draft or published, with inheritance and variations) directly on the canvas, then reset to the original text.
- **Context:** once the file's Figma link is saved, ReRune knows which layers show each key, and pushes can upload a screenshot of each changed frame. Translators see where a key is used in the dashboard's Design tab, and AI agents can ask ReRune's MCP server for the keys of a Figma frame.
- **Developers** see the linked keys of a selection in Dev Mode, with their values in every language, and copy snippets for React (i18next), Flutter, Android, iOS and Angular from the inspect panel or Dev Mode's Code section. Dev Mode needs a paid Figma plan, and the design-only build leaves it out (see [Build and release](#build-and-release)).

No AI features run inside the plugin. Keys created from Figma count toward the ReRune plan's key limit.

## Requirements

- A ReRune account. Designers join free on every ReRune plan.
- Figma Design: a Full seat, or a Starter plan with edit access to the file. Everything except Dev Mode works on the free Starter plan.
- Dev Mode features (the inspect panel, the Code section and Figma for VS Code) need a paid Figma plan with a Dev or Full seat. Testing them needs one too: the checks in [`TESTING.md`](TESTING.md) marked "needs a paid Figma plan" (§5.5 inspect panel, §5.6 codegen, Figma for VS Code in §7, the library-component fixture and spike S14). On the free plan, skip those checks and ship the design-only build (`npm run zip:design-only`). The branch checks in `TESTING.md` need a Figma Organization or Enterprise plan, the only plans with branching; the plugin itself needs no branching.

## Install

- **Community:** the Figma Community link will be added here once the plugin is published.
- **Development build:** see [Development](#development).

## Using the plugin

1. **Sign in with ReRune.** The plugin shows a code and opens ReRune in your browser; check that the codes match and click Connect there. The plugin then shows "Signed in as {email}" (**Not me** signs out again). Figma desktop and browser Figma keep separate sign-ins.
2. **Choose a project** for the file and, optionally, paste the file's link (**Share → Copy link**). Everyone who opens the file with the plugin gets the same project.
3. **Layers:** scan the selection or the page, link layers to existing keys (search, or **Link exact matches** for texts that already exist in ReRune), or mark them to create new keys with a suggested name. Linked layers whose text is longer than the key's max length are marked **Over max length** (filter **Too long**).
4. **Push** sends new and changed texts to ReRune as drafts after a review of every change and conflict, and can update layers whose key changed in ReRune. A change longer than the key's max length is held back until it fits.
5. **Preview** shows a language on the canvas; **Reset** restores the original text and styles. Under **Sample values and plural forms** you give placeholders sample values (kept per project on your machine) and pick the plural form to show, from the categories of the language you preview. Values longer than their key's max length are listed after the preview.
6. **QA:** **Run overflow report** previews each language you pick (plus pseudo text with **Include pseudo-localization**) on the layers in scope, lists the layers whose text is clipped, truncated or runs outside its frame and the values longer than their key's max length, and resets the canvas when it ends (keep the plugin open until then); **Copy CSV** copies the table. Its values, and those of language copies, use the **Sample values and plural forms** set on the QA tab or on Preview (the same values; the plural form list shows the forms of the first language picked). **Make language copies** duplicates each frame of the selection once per language, to the right of the original, with the text in that language. **Pseudo-localize** replaces the letters of every text layer in scope with accented look-alikes and makes it about 30–40% longer, to find text that clips before translations exist; Reset restores it like any preview.
7. **Settings:** key-name template and case style, scan options, "Upload screenshots of changed frames", the file's Figma link, and Diagnostics (Advanced).

The overflow report measures the layers in Figma, one language at a time; ReRune's server only adds the max length check. A text box of fixed size is **Clipped** when its text needs more than 1.5 px more height than the box (measured on a temporary copy whose height follows the text, removed at once), or when its rendered text reaches more than 1.5 px past the box's left or right edge (after what drop shadows, blurs and strokes can add on that side). Text with an ending ellipsis or a line limit is measured on a temporary copy without truncation, which is removed at once (**Truncated**). Text that sizes itself and reaches more than 1.5 px past its parent frame's inner box (the frame minus its auto-layout padding) on a side the frame cannot grow is **Outside its frame**. Linked layers without a value in a language keep their source text and are not measured. The report starts only when no layer in scope shows a preview ("Layers in scope show a preview. Reset previews first."), and resets exactly the layers it previewed when it ends, also when it stops early, after any reset that was already running. The reset runs in the plugin window: closing the plugin during the report leaves the language it was checking on those layers. Whenever the plugin opens on a page, or the page changes, it counts the text layers that still own a preview record there and, when the scan shows none of them (for example nothing is selected), says "N layers on this page still show a preview." with **Reset page**.

Language copies work on top-level frames and instances (a component or component set is refused, because copying it would create new components) and are refused while a layer in those frames shows a preview. Each copy is named "<frame> · <lang>", sits in the same parent as the original (also inside a section), is marked as a language copy and is left out of scans, pushes and link sync. Text without a value in that language and variable-bound text keep the source text, and so do layers the scan skips (hidden layers, also a hidden layer of a component in the frame, locked layers unless included, and `_` layers): show a hidden layer in a copy and it has the source text. Undo removes the copies of one frame at a time.

Plural and ICU values are rendered with the sample values: without a sample a placeholder shows as `[name]`, and a plural message shows the form you picked or, by default, its `other` form, with `#` as a count of that form (formatted for the language). Plural categories follow the CLDR rules of the language as the browser knows them; a regional language such as `de-AT` uses the rules of `de`, as ReRune does. A `zero`, `one` or `two` form in a language whose rules lack that category stands for exactly 0, 1 or 2, as in Flutter and i18next (ReRune stores Flutter's `=0`, `=1` and `=2` this way): English `zero {No items} one {# item} other {# items}` shows "No items" for 0, the plural form list offers zero (0), one (1) and other (2), and the default `other` form uses a count that no such form claims ("2 items"). The list is built from the forms of the language you preview (on QA: the first language picked), which can differ from the main language's: a German translation with a `zero` form offers zero (0) in German although the English value has none, and the plugin asks ReRune for that language's forms (one resolve per language, source and variation) when you change them.

Once the file's Figma link is pasted (Project screen or Settings → Figma file), the plugin also keeps ReRune's list of which layer shows which key up to date, so the dashboard can show where a key is used: after every link, unlink and push, and on **Sync links on this page**. Saving the link in Settings, or **This is the same file** for a suspected copy, also shares the open page's links once, on the open tab, so layers linked before reach ReRune too; this run only adds and updates links (removals wait for **Sync links on this page**), and other pages follow when you run **Sync links on this page** there. ReRune's link for a layer is removed only when the layer exists and shows no key or another key; links whose layer is not found are listed and removed only on request. Branch files and files that may be copies (their name differs from the one stored with the link) pause this until the link is confirmed, because they share layer IDs with the original file. Without the Edit keys permission links stay in the file only.

With **Upload screenshots of changed frames** on (Settings → Push), a push, **Overwrite ReRune**, **Take ReRune text** and **Update layers from ReRune** end by uploading an image of each top-level frame whose layers they changed, with a box for every linked layer in it (for an update from ReRune: the layers given ReRune's text, the instances that show an updated main component, and the main component's own frame when it was in scope). Main exports one frame per request (JPG, or PNG for frames without an opaque fill; at most 4096 px on the long side and 2 MB, exported smaller when needed) and computes the boxes; the UI checks the decoded size and uploads the frames one by one. Frames that show a language preview are skipped. Uploads run only when the ReRune server stores screenshots, the account is not a sandbox account, the file's link is confirmed (no branch, no suspected copy) and you can edit keys.

With a ReRune server that supports it (its `GET /figma/meta` says `screenshot_freshness: true`), each box also records the layer's text at export (layers longer than 5,000 characters send none). ReRune compares each box's text with the key's draft text in the main language, so the dashboard marks a screenshot **Outdated** when its text no longer matches. When a frame's boxes would pass 900,000 bytes, texts are dropped, longest first. With an older server the boxes are sent without text.

Members of the project can ask for new screenshots in the dashboard (of one screenshot, or of every outdated screenshot of a file). With such a server, the plugin reads the file's requested frames when the workspace opens on a file with a confirmed link, after the link is saved and after every screenshot upload, and again while it stays open: when its window is shown again, focused or pointed at (at most every 15 seconds), and every minute while it is visible and in use. After 15 minutes without a click, key or scroll in the plugin, the pointer moving onto it or a selection change in Figma, it stops until the next one. It does not read while the window is hidden (for example with Figma minimised) or while a push, **Update screenshots** or another task runs. After a failed read it shows no error and waits longer, up to 10 minutes; coming back to the plugin a minute later, or the connection coming back, reads sooner (a 429's wait is always kept). When the server check (`GET /figma/meta` and the account) fails as the workspace opens, the plugin repeats it on the same schedule, so the notice still shows without reopening the plugin. It shows, first on every tab, "ReRune asks for new screenshots of N frames in this file." with who asked ("Requested by …") and the first five frames. **Update screenshots** (it needs the same as an upload, except the setting: an explicit request is not an automatic upload) reads those frames on whichever page they are, with the file's scan options, stops when one of their layers shows a preview ("Reset previews in these frames first." with **Reset previews**), gives the layers changed in ReRune ReRune's text (as **Update layers from ReRune** does) and uploads every requested frame that is still in the file, in order, with **Stop** while it uploads. Layers changed in Figma or in both, layers of disabled keys and plural or ICU texts are never changed: the results count them, together with the screenshots that still show text other than ReRune's. Requested frames that are not in the file anymore, and hidden ones (also in a hidden section: their screenshot would show no keys, so they are not uploaded), are listed with **Remove request** (and **Remove all**). The tabs stay locked while it runs. **Not now** hides the notice for this plugin session until a new request arrives; the requests of a finished run are put aside the same way, so frames it could not upload don't bring the notice back at once.

In Dev Mode the plugin is read-only. The inspect panel signs in like Figma Design does, then shows each linked key of the selection: its status, max length, its value in every project language (**Draft** or **Published**, with inherited and missing values marked), the snippet for the platform you pick (remembered on your machine) with **Copy code**, and **Open in ReRune**. Every time it loads values it refreshes the codegen cache. The Code section (Dev Mode → Code, one language per platform) never calls the network: it reads the links in the file and that cache, so a key renamed in ReRune shows its new name there after the inspect panel or a Figma Design session has loaded it. Keys the cache does not know yet get a snippet without placeholders and a note to open the inspect panel. A frame lists at most 50 keys ("More keys not shown").

## Development

Requirements: Node 24 (see `.nvmrc`), npm, and the Figma desktop app (macOS or Windows). Plugins in development are imported in the desktop app; browser Figma runs only published plugins.

**Windows:** the scripts set variables the POSIX way (`RERUNE_ENV=development build-figma-plugin`), which `cmd.exe` and PowerShell do not understand. Run them from Git Bash or WSL, or let npm use Git Bash for scripts once: `npm config set script-shell "C:\Program Files\Git\bin\bash.exe"`. The same goes for the design-only command below.

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
| Production, design-only | `npm run build:design-only`, `npm run zip:design-only` | `https://rerune.io/api` | `https://rerune.io` |

`RERUNE_ENV` picks the build (`production` by default, or `development`); any other value fails the build. The development build adds the "ReRune diagnostics" codegen language, and only development builds open `http://localhost` / `http://127.0.0.1` links (production builds open `https://` links only). All builds write the same `manifest.json` (not committed), so run `npm run build:dev` again after a production build before testing locally.

`RERUNE_DEV_MODE` picks the variant: `on` (the default) keeps Dev Mode; `off` writes a design-only manifest with `editorType` `["figma"]` and no `capabilities` or `codegenLanguages` (no inspect panel, Code section or Figma for VS Code). The plugin ID, network access, `documentAccess` and the code are the same in both, except that the design-only build keeps no codegen cache (`__RERUNE_DEV_MODE__` is `false`; nothing would read it). Any other value fails the build. It combines with `RERUNE_ENV`: `RERUNE_ENV=development RERUNE_DEV_MODE=off npx build-figma-plugin` is a local design-only build for checking what a design-only release does.

### Import the development build into Figma

1. Figma desktop → **Plugins → Development → Import plugin from manifest…** → pick `manifest.json` in this folder.
2. Run it from **Plugins → Development → ReRune** in Figma Design. In Dev Mode (paid Figma plan) it is in the inspect panel's plugins, and its languages are in the Code section's language dropdown.
3. After a rebuild, run it again (⌥⌘P on macOS, Ctrl+Alt+P on Windows) or turn on **Plugins → Development → Hot reload plugin**.

Figma keys the plugin's local storage (sign-in, preferences) by the plugin ID in `package.json` → `figma-plugin.id`. The ID `1697181748239106841` was issued by Figma when the plugin was created; never change it, or every user is signed out and loses their preferences.

### Point it at a local ReRune

The development build always calls `http://localhost:8080` and opens the dashboard on `http://localhost:3000`. The manifest allows the local API only for imported development plugins (`devAllowedDomains`); other hosts are blocked by Figma.

1. **Server** (`rerune-server`): in `.env`, set `HASH_SECRET` and `FIGMA_CONNECT_URL=http://localhost:3000/figma/connect`, then `go run ./cmd/api`. Without `FIGMA_CONNECT_URL`, sign-in fails with "Sign-in with ReRune isn't available right now". The `/figma/` routes accept the plugin's `null` origin by themselves; never add `null` to `CORS_ALLOWED_ORIGINS`.
2. **Screenshots** (optional): set `DESIGN_STORAGE_ENABLED=true` and the other `DESIGN_STORAGE_*` values of a Bunny storage zone and pull zone (the server's `env_sample.txt` and `docs/runbooks/design-storage.md`). Without them the plugin works, but uploads nothing and hides "Upload screenshots of changed frames".
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
| `npm run build:design-only` | Production build without Dev Mode (`RERUNE_DEV_MODE=off`) |
| `npm run zip:design-only` | Design-only production build packed as `rerune-figma-plugin-design-only.zip` |

### Tests

Unit tests sit next to the code (`*.test.ts`). A few tests check the repository as a whole:

- `test/message-contract.test.ts`: every message type is sent by one side and handled by the other, each UI handles what main posts in its mode, and every request main receives gets exactly one answer.
- `test/dev-mode-policy.test.ts` and `src/ui/dev-mode-ui.test.ts`: Dev Mode refuses every write, the messages it accepts leave a file unchanged, codegen never writes or calls the network, and the Dev Mode UI never builds a message Dev Mode refuses.
- `test/docs.test.ts` and `src/ui/api/readme.test.ts`: this README and `TESTING.md` match the build, the screens and the endpoints the plugin calls.
- `test/build-hooks.test.ts` and `test/release.test.ts`: both manifest variants, the npm scripts, the CI workflow and the release check in `scripts/check-build.mjs`.
- `test/listing.test.ts`: `COMMUNITY_LISTING.md` matches the manifest and the code, and the images in `listing/` are the rendered art (opaque 8-bit PNGs at Figma's sizes) and are all listed.

Some of these read the sources through `import.meta.glob`. Vitest caches module graphs in `node_modules/.vitest-cache`; after adding or removing source files, run `rm -rf node_modules/.vitest-cache` (or `npm ci`) if a contract test reports a file list that looks stale.

Everything that depends on real Figma behaviour (sign-in, scans of large files, instances, preview restore, Dev Mode, link sync on branches and copies, screenshots, the spike questions) is tested by hand: see [`TESTING.md`](TESTING.md).

## Build and release

There are two release builds. Both use the plugin ID `1697181748239106841`, the same network access and the same code (only the design-only build keeps no codegen cache), so a later release can switch from one to the other as an update of the same Community plugin. After a switch to the full build the Code section fills its cache from the next inspect panel or Figma Design session.

| Release | Command | Archive | Manifest |
|---|---|---|---|
| Design-only | `npm run zip:design-only` | `rerune-figma-plugin-design-only.zip` | `editorType ["figma"]`; no `capabilities`, no `codegenLanguages` |
| Full (with Dev Mode) | `npm run zip` | `rerune-figma-plugin.zip` | `editorType ["figma","dev"]`; `capabilities ["inspect","codegen","vscode"]`; 5 codegen languages |

**Which one to ship:** the design-only build, unless Dev Mode has been tested on a paid Figma plan: `TESTING.md` §5.5 (inspect panel) and §5.6 (codegen) passed, and spike S14 shows the plugin in Dev Mode's inspect panel and Code section. Without that test the full build would ship Dev Mode features nobody has seen working. Designers on the free Figma plan get the whole design-side plugin either way; Dev Mode features need a paid Figma plan with a Dev or Full seat.

**Release steps:**

1. CI (`.github/workflows/ci.yml`, Node 24) runs typecheck, lint and tests on every push to `main` and every pull request, builds both archives, checks each with `node scripts/check-build.mjs full` / `design-only` (production hosts only, no `localhost` in the bundles, the manifest of that variant) and uploads them as the artifacts `rerune-figma-plugin` and `rerune-figma-plugin-design-only`. Locally, the same zip command followed by the same check does the same.
2. Put the chosen build where Figma desktop imported the plugin from: run its build command (`npm run build:design-only` or `npm run build`) in this folder, or unzip the CI archive here over `manifest.json` and `build/`, and check it with `node scripts/check-build.mjs design-only` (or `full`). Then publish from the Figma desktop app (2FA required) under the BasalBit/ReRune profile. Figma publishes the files the imported `manifest.json` points at, so don't rebuild (for example `npm run build:dev`) until the publish is done.
3. The listing text, assets, data security answers and reviewer notes are in [`COMMUNITY_LISTING.md`](COMMUNITY_LISTING.md); changes go in [`CHANGELOG.md`](CHANGELOG.md).

### Listing images

The Community icon, cover and carousel images in `listing/` are rendered from `listing/src/art.html` (one template per image, in the look of the dashboard's /figma page and share card) with the plugin's real screens. Both steps need Chromium or Chrome: set `CHROME_BIN` to its binary, or leave it out to use the installed Google Chrome. They are not run in CI.

```bash
CHROME_BIN=… node scripts/listing-art.mjs capture   # builds the design-only and the full plugin, captures the screens into listing/src/shots
CHROME_BIN=… node scripts/listing-art.mjs render    # writes listing/*.png
```

`capture` runs `scripts/ui-harness.mjs`: the built `build/ui.js` in headless Chromium inside a page that plays Figma's main thread on fixture layers, with Figma's light or dark theme variables, and answers for the ReRune API from fixtures (nothing leaves the machine). It builds both variants in this folder and then puts back the `build/` and `manifest.json` that were there, so the build Figma desktop imported stays as it was. Before publishing, capture and render from the commit you publish first, then put the release build in place and check it (Build and release, step 2).

Run the harness alone for review screenshots of every screen in light and dark: `node scripts/ui-harness.mjs <out dir> [scenario …]` after `npm run build`. The Design screens render at 400 × 640 and at the window's 360 × 480 minimum, the Dev Mode panel at 300 × 480 and 300 × 200. `checks.json` reports horizontal scrolling, content pushed above the top of a scroll area, the layout shift while a screen loads, text under 4.5:1 and whether the brand fonts loaded. Every run sets reduced motion except `07-push-results`, which plays the postmark's stamp-in.

## Architecture

The plugin is built with [Create Figma Plugin](https://yuanqing.github.io/create-figma-plugin/) and Preact.

Code comments that cite a section (`§7.14`), a decision (`D32`), a spike (`S5`) or the "tooling map" refer to ReRune's internal design notes for this integration, which are not part of this repository. The comment next to each reference says what the code does, and this README and [`TESTING.md`](TESTING.md) describe the behaviour without them.

- `src/main` runs in Figma's main thread: canvas reads and writes, plugin data, `clientStorage`, frame exports. It targets ES2017 and has no DOM types.
- `src/ui` runs in the plugin iframe: screens and every call to the ReRune API. `src/ui/api` is the fetch client and one function per endpoint, `src/ui/state` the framework-free screen logic (pairing poller, scans, push and preview orchestration, sample values, link sync, screenshot uploads and requests (with the watch that reads them while the plugin stays open), the inspect panel; unit-tested in node), `src/ui/screens` the Preact screens. `src/ui/app.tsx` renders the Design-mode app, or the Dev Mode inspect app (`src/ui/inspect-app.tsx`) in Dev Mode.
- `src/shared` holds pure, unit-tested logic used by both: message types, wire types, plugin-data parsing, hashing, key-name suggestions, Figma URL parsing, sync state, the push plan, ICU sample rendering and pseudo-localization.
- `src/codegen/snippets.ts` builds the code snippets for React (i18next), Flutter, Android, iOS and Angular. It is pure and shared by the Dev Mode Code section (main) and the inspect panel (UI).

### Messages

Main and UI talk only through typed messages (`src/shared/messages.ts`). Every UI → main message has an impact in `src/shared/message-policy.ts`, and the main bus checks it before any handler runs: Dev Mode accepts `ui` and `read` messages and refuses every `metadata` and `canvas` message (Figma shows "Not available in Dev Mode"). `metadata` and `canvas` messages run one at a time in the order they arrive, so two writes never interleave on a layer; the UI also runs one canvas task at a time (push, preview, pseudo-localization, overflow report, language copies, Update screenshots) and keeps the tabs locked meanwhile. Each `metadata` or `canvas` message is one undo step, except that one preview apply, one pseudo-localization run and one overflow report are one undo step each: their `preview-apply` and `overflow-check` messages are sent with `commit: false` (all but a preview's last batch; every one of the report's, whose final `preview-reset` commits), so one ⌘Z reverts a whole preview and never brings back the last language of a report. Main answers every request with its answer or a `handler-error`, so the UI never waits for its 30-second watchdog.

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
| `overflow-check` | `canvas` | no | `overflow-result` |
| `language-copies` | `canvas` | no | `op-result` |
| `diagnostics-write` | `canvas` | no | `diagnostics-result` |
| `diagnostics-devmode-probe` | `devprobe` | development builds only | `diagnostics-result` |

Main also sends `selection-changed` (Design mode) and `inspect-selection` (Dev Mode) when the selection or page changes, and `handler-error` for a refused or failed message. Four details of the messages are easy to miss: `link-check` / `link-check-result` read layers with hidden instance children included, and with `inheritors` (as after a link, unlink or push) main also answers for the current page's instance sublayers that inherit from a checked text inside a component; screenshot export skips a frame that shows a preview with the reason `preview_active` (and a hidden one with `hidden`); a pull's `text-apply` items carry the `expectedSrc` of the text the layer was scanned with, and main leaves a layer whose text changed since alone (`changed_meanwhile`); and `inspect-selection` sets `truncated` when a selected frame has more than 50 linked layers (the panel lists each key's first layer first and says that more are not shown). A `scan-request` with `frameIds` (Update screenshots) scans those frames instead of the scope, loading each frame's page, and its `scan-done` lists the frames that are not in the file (or cannot be exported) in `missingFrameIds` and the hidden ones, which it does not scan, in `hiddenFrameIds`; a page change does not cancel it.

### Data in the file

Everything the plugin stores in a file is shared plugin data in the namespace `rerune` (JSON strings, readable by every build of the plugin):

| Node | Key | Value |
|---|---|---|
| text layer | `link` | `{"v":1,"id":"<keyId>","k":"<keyName>","p":"<projectId>","src":"<hash>","nid":"<node id at link time>","t":1761550000000}`, or the tombstone `{"v":1,"none":true}` after an unlink that could not clear inherited data |
| text layer | `preview` | the original text and styles while a preview is shown, with the `nid` it was written on |
| text layer | `diag` | test marker `{"v":1,"nid":"<node id>","t":…}` written by **T1 Mark** under Settings → Advanced → Diagnostics (every build, only when you run that write test) |
| frame | `langCopy` | marks a language copy of a frame: `{"v":1,"nid":"<the copy's id>","lang":"de","source":"draft","variationOptionId":null,"sourceFrameId":"<original frame id>","createdAt":…}`; a marker whose `nid` is another frame's (a duplicated copy) does not count |
| document and each page | `file` | the file's settings: ReRune server, project, the pasted Figma file link (file key, canonical URL, file name, branch key), key template and scan options |

`src` is a hash of the normalised text, so the plugin can tell which side changed. `nid` lets it recognise copied layers and layers inside instances. Linked layers also get Figma's relaunch button **Open ReRune** (relaunch data), which opens the plugin on them. The plugin writes plugin data only when you act (link, unlink, push, pull, preview, reset, overflow report, language copies, saving settings, write diagnostics), never during a scan and never in Dev Mode.

### Data on your machine

Figma's local plugin storage (`clientStorage`, per plugin ID, separate for Figma desktop and browser Figma) holds:

| Key | Value |
|---|---|
| `rerune.auth.v1` | the sign-in per ReRune server: plugin token, its ID and expiry, your name and email |
| `rerune.prefs.v1` | preferences: last preview language, source and variation, "Upload screenshots of changed frames" (stored as `uploadScreenshotsOnPush`), the inspect panel's platform, "Create one key for layers with identical text", and the sample values of each project's placeholders |
| `rerune.codegen.v1.<projectId>` | the codegen cache of one project: key name, placeholders and up to 60 characters of source text per key, at most 2,000 keys (builds with Dev Mode only; the design-only build keeps none) |
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
| `GET /figma/projects/{project_id}/screenshots` | the frames of this file that ReRune asks new screenshots of |
| `DELETE /figma/projects/{project_id}/screenshots/{screenshot_id}/refresh-request` | Remove request, for a requested frame that is not in the file anymore |

### Look and feel

Figma does the controls and surfaces; ReRune does identity, data and states. Buttons, text fields, dropdowns, segmented controls and toggles are Create Figma Plugin's, the surfaces are Figma's theme colours (`themeColors: true`, light and dark follow the editor), and `src/ui/brand` adds the ReRune layer in one stylesheet (`brand-css.ts`, injected by `GlobalStyle`): the mark and wordmark in the header, key names as `‹ key ›` tags, one recipe for state chips and notes (a shape next to each label; ReRune-side chips have an amber dot on the key tag's white, ReRune's notes the amber wash and edge), text links with an amber underline, mono caps for section titles (field labels stay Figma's 11 px sentence case), and a focus ring on every control the plugin draws itself. The chip of each sync state comes from `STATE_TONES` (`src/ui/state/layers.ts`), so every screen agrees. `tokens.ts` holds the colours (the dashboard's tokens) and `tokens.test.ts` checks every pair the plugin draws against WCAG contrast in both themes. The fonts are bundled in `build/ui.js` and registered from bytes (`src/ui/brand/fonts.ts`): Inter (as "ReRune Inter", so an installed full Inter fills in the letters its Latin subset lacks) for text, IBM Plex Mono for keys and codes, and Bricolage Grotesque for the wordmark and the sign-in heading; no font is fetched. They make `build/ui.js` about 110 KB larger; `scripts/check-build.mjs` fails a release whose `build/ui.js` is over 450,000 bytes or carries no fonts, and one whose `build/main.js` carries any. The mark's sources are in `assets/brand`.

## Privacy

The plugin talks only to the ReRune API (the endpoints above), and only while it is open and you use it. It sends the texts you push (with the frame name as the new key's description) and the texts you search for. To find keys that already have a layer's text, it also sends texts it does not push: opening **Push** sends the text of every unlinked text layer in scope and the key names it suggests for them, and the Link dialog and **Link exact matches** send the text of the selected layers (the Link dialog also searches for the first 100 characters of the layer's text). These lookups create nothing in ReRune. The plugin also sends the IDs of the keys it shows (the Dev Mode inspect panel loads the values of the selected layers' keys; the Code section sends nothing). When you paste the file's Figma link, it also sends the file's key, link and name, and for linked layers their layer IDs and the layer, frame and page names. With **Upload screenshots of changed frames** on, a push or an update from ReRune also uploads an image of each frame it changed, with the frame and page names, the positions of the linked layers and, with a ReRune server that supports it, each linked layer's text; ReRune stores the images in its EU image storage and the rest with the project. With such a server the plugin also reads which frames of the file ReRune asks new screenshots of (frame and page names and who asked), and **Update screenshots** uploads those frames the same way, whatever the setting says. Sandbox accounts never upload images. Sign-in pairs the plugin with your ReRune session in the browser; the plugin stores its token only in Figma's local plugin storage on your machine and sends it only to the ReRune API. See the [ReRune privacy policy](https://rerune.io/privacy).

## Licence

[MIT](LICENSE), Copyright (c) 2026 BasalBit.

Third-party fonts: the plugin bundles Inter, IBM Plex Mono and Bricolage Grotesque, and the listing art uses Bricolage Grotesque, Hanken Grotesk, Newsreader and IBM Plex Mono, all under the SIL Open Font License 1.1. Their licences and sources are next to them in `src/ui/assets/fonts` and `listing/src/fonts`.
