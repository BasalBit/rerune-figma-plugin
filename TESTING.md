# Manual testing

Figma has no emulator, so everything that depends on real Figma behaviour is tested by hand: in the **Figma desktop app** on macOS and Windows, in **browser Figma** and in **Figma for VS Code** (Dev Mode). Unit tests (`npm test`) cover the logic around it.

How to use this file:

- Work through the sections in order. Sections 0–4 and the spike questions (§8) are Phase 1; §5 needs the Phase 2 features and §6 the Phase 3 features.
- Tick a box when the expected result happened. When it didn't, leave it unticked, add a line under it starting with **Issue:** and file a GitHub issue.
- Add one row to the [results log](#results-log) per run, and paste diagnostics reports under [Spike reports](#spike-reports).
- Diagnostics write tests (T1-mark, T2-clear, T5, T8) change the document. Run them in a scratch copy of the fixture file and undo afterwards.

**Phase 1 is done when** §0–4 pass on Figma desktop, every spike question S1–S14 has an answer and a chosen branch, the full round trip works on the Chapter design (88 keys, 7 languages, plus `de-AT` added for the test), and a page with more than 500 text layers scans without freezing Figma.

---

## 0. Setup

### 0.1 Plugin ID (once, before the first test)

Figma keys `clientStorage` (sign-in, preferences, codegen cache) by the plugin ID, so get the real ID before testing and keep it.

- [ ] Figma desktop → **Plugins → Development → New plugin…**, pick **Figma design** and **Dev Mode** as editors and any template, and save it somewhere outside this repo.
- [ ] Copy the `id` from the generated `manifest.json` into `package.json` → `figma-plugin.id` (replacing `0000000000000000000`), commit it, and delete the generated folder.

### 0.2 Build and import

```bash
npm ci
npm run build:dev    # or: npm run watch (rebuilds on change)
```

- [ ] `manifest.json` exists in the repo root and its `codegenLanguages` end with **ReRune diagnostics** (development builds only).
- [ ] Figma desktop → **Plugins → Development → Import plugin from manifest…** → pick `manifest.json` in this repo. **ReRune** now shows under Plugins → Development.

The development build calls the API at `http://localhost:8080` and opens the dashboard at `http://localhost:3000` (`devAllowedDomains` allows the local API for imported plugins only). `npm run build` writes a production `manifest.json` over it (API `https://rerune.io/api`), so run `npm run build:dev` again before going back to local testing. After a rebuild, re-run the plugin (⌥⌘P on macOS, Ctrl+Alt+P on Windows) or turn on **Plugins → Development → Hot reload plugin**.

### 0.3 Local server and dashboard

Server (`rerune-server`; before the merge use the `rerune-server-figma` worktree), with Mongo (replica set) and Keycloak running as usual:

- [ ] `.env` from `env_sample.txt`, with `HASH_SECRET` set and `FIGMA_CONNECT_URL=http://localhost:3000/figma/connect`. Without it, **Sign in with ReRune** ends with "Sign-in with ReRune isn't available right now. Try again later." and the server logs an error at startup.
- [ ] `/figma/` routes allow every origin, so `CORS_ALLOWED_ORIGINS` needs no entry for the plugin. Never add `null` to it.
- [ ] For the sandbox tests set `SANDBOX_ENABLED=true`.
- [ ] To check the connection email, configure the server's mail settings. Without them the email step fails quietly (server log line `operation=figma_connected_email outcome=failure`).
- [ ] `go run ./cmd/api` → listens on `PORT` (8080).

Dashboard (`rerune-dashboard`; before the merge the `rerune-dashboard-figma` worktree):

- [ ] `pnpm dev` → `http://localhost:3000`. `NEXT_PUBLIC_API_URL` defaults to `http://localhost:8080`.

Connectivity:

- [ ] In the plugin, **Diagnostics** (Sign in screen, bottom right; later Settings → Advanced → Diagnostics) → **Network check** → report shows `"ok": true`, `"status": 200`, `"cors": "ok"` and the E1 `meta` body.

### 0.4 Accounts

- **A**: owner of the test project (has Edit keys).
- **B**: a second account (for "approved by another account").
- **Viewer**: a member of the test project without Edit keys.
- **Sandbox user**: started from `http://localhost:3000/sandbox`.
- **Small plan**: an account on a plan with only a few keys left (quota test).

### 0.5 Fixture project

- The sandbox seed (**Chapter**: 88 keys, 7 languages en/de/es/it/pt/fr/sq, a `vip` variation), or your own copy of it in account A.
- The seed has no regional language: add **`de-AT` with no values** to the test project (inherits from `de`) to test inherited preview.
- For the RTL note in §4: optionally add an RTL language (e.g. `ar`) with a few values.

### 0.6 Fixture Figma files

No Chapter Figma file exists in the repos; build or supply one (a public example file in `rerune-web-examples` is an optional ops step). The file needs:

- [ ] The Chapter screens as top-level frames, one of them inside a **section**.
- [ ] A **component** with a text layer, used in at least three **instances**; a **nested instance** (an instance of a component that contains that instance); a component with a **variant** or boolean property that hides a text layer.
- [ ] An instance of a **library component** (publish a second file as a library, use its component here).
- [ ] Text with a **text style**, text with a **colour style**, text with a **hyperlink**, text bound to a **string variable**, and text bound to a **component property**.
- [ ] A text layer whose font is **missing** on the test machine.
- [ ] Hidden, locked, numeric-only (`42`, `1.5`) and `_`-prefixed text layers.
- [ ] A page with **more than 500 text layers** (duplicate the Chapter frames until it has enough).
- [ ] A **second file** in the same Figma team for cross-file paste tests.

---

## 1. Sign-in

Plugin side: **Sign in with ReRune** → Pairing screen (code, "Check that the code in your browser matches", countdown "Code expires in …", **Open browser again**, **Cancel**) → **Signed in as {email}** (**Not me** / **Continue**) → Project screen. Browser side: `/figma/connect?code=XXX-XXX`.

- [ ] **Existing user, signed in to the dashboard.** The browser opens the connect page by itself. It shows the same code, "Connecting as {email}", the "Only continue if you started this" warning, **Connect** and **This wasn't me**. Connect → "Figma plugin connected" → the plugin shows "Signed in as {email}" with the name → Continue → "Choose a ReRune project".
- [ ] **Logged-out user.** The connect page sends you to `/login?figma_code=…`; after login you are back on the connect page with the same code.
- [ ] **Session expired in the dashboard** (stale token whose refresh fails, e.g. end the user's session in Keycloak): you land on `/login?code=…` and after login back on the connect page.
- [ ] **New user.** **Create an account** opens `/register`. Register and verify the email, then start sign-in again in the plugin: it works.
- [ ] **Expired code.** Wait out the countdown (10 minutes): the plugin shows "Code expired. Start sign-in again." with **Start again** / **Back**; the connect page shows "This code has expired".
- [ ] **This wasn't me.** The page shows "Request blocked"; the plugin shows "Sign-in was blocked in the browser."
- [ ] **Another network.** Open the connect link on a phone using mobile data: the code is hidden, the page asks "Enter the code from Figma", a wrong code shows "This code doesn't match…", and **Connect** works only with the matching code. Locally the phone needs the dashboard and API through a tunnel; otherwise do this check in production acceptance (§9, step 4).
- [ ] **Approved by another account.** Start sign-in, approve the link as account B, then open the same link as account A: "This code was approved by another account". The plugin shows "Signed in as {B's email}".
- [ ] **Not me** on "Signed in as" signs the plugin out (Sign in screen) and the connection disappears from B's Profile → Connected apps.
- [ ] **Connection email** ("Figma plugin connected": "The ReRune Figma plugin was connected to your account at …") arrives after a successful sign-in; **Review connected apps** opens Profile.
- [ ] **Sandbox user.** Pairing works, the connect page says "This connection ends when your sandbox ends.", no connection email is sent, and (Phase 2) Settings has no "Upload screenshots on push" option.
- [ ] **Revoke in Profile** (Profile → Connected apps → Revoke → confirm): the plugin's next call ends on the Sign in screen with "Your session ended. Sign in again."
- [ ] **Sign out in the plugin** (Settings → Account → Sign out, or Sign out on the Project screen): the connection is gone from Profile → Connected apps.
- [ ] **Password reset** of the signed-in user: the plugin is signed out on its next call.
- [ ] **Cancel** on the Pairing screen returns to Sign in; **Open browser again** opens the same connect link again.
- [ ] Closing and reopening the plugin keeps you signed in. Figma desktop and browser Figma have separate plugin storage: sign in once in each.

---

## 2. Scan

- [ ] Select two frames → Layers → **Selection** → **Scan**: their text layers are listed, grouped by frame, with state chips (Not linked, Synced, …).
- [ ] **Page** → **Scan** lists every text layer on the page. Selection → Scan with nothing selected shows "No text layers in the selection. Select frames or text, then scan again."
- [ ] **500+ layer page:** Page scan finishes; while it runs ("Scanning… N layers") the canvas stays usable (pan, zoom, select). Delete a text layer mid-scan: the scan still finishes. Note the time in the results log.
- [ ] Hidden layers (also inside hidden groups), locked layers, numeric-only text, empty text and layers whose name starts with `_` are skipped; the summary line next to "Select all shown" counts them.
- [ ] Settings → **Include locked layers** and **Ignore layers whose name starts with _** change what the next scan lists.
- [ ] Optional: a page with more than 5,000 text layers shows "Only the first 5,000 text layers are listed. Scan a smaller selection to see the rest."

---

## 3. Link, create and push (round trip on Chapter)

- [ ] **Connect the file:** "Choose a ReRune project" → Chapter → Layers. Reopen the file as another user with the plugin: it opens the same project ("The file remembers this project for everyone who opens it with the plugin").
- [ ] **Link existing keys:** click a row → Link dialog → **Search keys** (prefilled with the layer text) → pick a key. Same text → the row turns **Synced** and shows the key name.
- [ ] **Different text:** the dialog says "The layer text differs from ReRune." **Use ReRune text** replaces the layer text (Synced); **Keep layer text** links it as **Changed in Figma** (pushed later as a draft).
- [ ] **Link exact matches:** select unlinked rows whose texts exist in ReRune → **Link exact matches** → "Linked N layers to keys with the same text." Texts with several matching keys are listed as "Several keys match "…" · Select", texts without a match as "N layers have no exact match · Select".
- [ ] **Create new keys:** Link dialog → **Create new key**: the suggested name follows the dominant pattern of Chapter's key names (check a few), can be edited, and is validated as you type. **Create on push** marks the row with "→ name". Nothing reaches ReRune yet.
- [ ] **Push:** Push tab → the review lists "New text (N)", "Changed in Figma (N)" and the quota line ("N keys left on your plan"). **Push N changes** → results. In the dashboard: new keys exist as drafts in the main language, tagged `figma`, description = the frame name, a placeholder exists for every `{{x}}` in the text, nothing is published.
- [ ] **Edit in ReRune → pull:** change a linked key's main text in the dashboard → Scan → row **Changed in ReRune** → Push tab "Changed in ReRune (N)" → **Update layers from ReRune** → layers show the new text and turn Synced.
- [ ] **Edit both → conflict:** change the same key in Figma and in ReRune → Push shows "Changed in both" with **Skip** / **Overwrite ReRune** / **Take ReRune text**; each does what it says. Change ReRune again between review and push: results show "Changed in ReRune meanwhile" with **Overwrite** and **Take ReRune text**.
- [ ] **Duplicate a linked layer** (⌘D/Ctrl+D): the copy shows **Copied** (filter "Needs attention"). **Keep copied links** / **Keep all copied links** keeps the link on the copy; on the Push tab "Copied layers" offers **Keep link** / **New key**.
- [ ] **Copied + divergent:** change the copy's text and keep its link → Push shows "Different texts on one key" with **Push this text** / **New key** / **Leave** per text.
- [ ] **Component text:** link the text in the main component → every instance lists the key with an **Instance** badge (Link dialog: "From main component"), including the nested instance. Override the text in one instance → that row is **Not linked** (Link dialog: "Text overridden") and Push offers to create or link a key for it.
- [ ] **Pull on inherited text:** change the component's key in ReRune → **Update layers from ReRune** updates the main component's text once; the instances follow and get no text override. For an instance of a library component the layer reports "Update this text in the library file".
- [ ] **Cross-file paste:** paste a linked frame into the second file, connect it to the same project, select the frame, Push (scope Selection). If the paste kept the links, the layers are listed under "Copied layers" (**Keep link**); if it dropped them, texts that exist in ReRune default to **Link to {key}** ("The same text exists in ReRune."). Either way, after pushing the dashboard's key count is unchanged (no duplicates).
- [ ] **Name taken:** create a key with a name that already exists → "Link to existing key {name}" is offered.
- [ ] **Unlink:** select linked rows → **Unlink** → Not linked. Unlinking an instance sublayer that shows the component's key leaves the other instances linked.
- [ ] **Disabled key:** disable a linked key's draft in the dashboard → the row is **Read-only** and is never pushed.
- [ ] **Structured key** (ICU plural/select): linking it shows **Read-only**; push never overwrites it.
- [ ] **Key deleted in ReRune:** the row shows **Key missing**; Push lists it under "Keys missing in ReRune" with **Skip** / **Recreate** / **Unlink**.
- [ ] **Quota:** with the small-plan account, mark more new keys than are left → the review warns "Only N keys are left on your plan…"; after Push the results say "Your plan's key limit is reached." with **Open ReRune**, and the keys that fit were created.
- [ ] **Viewer:** the Project screen marks the project **View only**; the Push tab says "You can view this project but not edit its keys, so you can't push."
- [ ] **Relaunch button:** select a linked layer → the right sidebar shows **Open ReRune** → it opens the plugin on Layers with the selection scanned.
- [ ] **Key-name settings:** Settings → Key names → Template (e.g. `{frame}_{layer}`) and Case style change the suggestions.
- [ ] **Settings repair and page mirror:** on a page whose settings differ from the file's, Settings shows **Repair settings**; on a new page without settings it offers **Use this file's ReRune settings on this page**.
- [ ] **Different server** (needs a production sign-in, so it can wait for §9): open a file connected with the development build in a production build → the Project screen says "This file is connected to a different ReRune server." and nothing is written until you choose a project on this server.

Dev Mode in Phase 1 (the full inspect panel is Phase 2, §5):

- [ ] Dev Mode (Shift+D) → inspect panel → plugins → **ReRune**. Nothing selected: "Select a text layer or a frame to see its ReRune keys." Unlinked text: "No ReRune key is linked to this layer." Linked text: its key name with **Copy** ("Copied", and the name is on the clipboard). A frame: the keys of its linked text layers ("from main component" for instance text).
- [ ] Dev Mode → Code → **React (i18next)** (any of the five languages): the key names of the selected layer or frame, each after a `//` comment with its text once a Design session has loaded the keys; unlinked → "No ReRune key is linked to this layer."
- [ ] Using the inspect panel and the Code section never changes the file (T9/S10 covers whether Figma would even allow it).

---

## 4. Preview

Preview tab: **Language** (with its inheritance chain), **Source** Draft / Published, **Variation**, **Show key names instead of text**, **Apply to** selection / page, **Reset**. While a preview is active the header shows "Previewing {lang} ({source}) on N layers · Reset".

- [ ] Every language (en, de, es, it, pt, fr, sq) as **Draft** and as **Published** shows the right values.
- [ ] **`de-AT`** shows the `de` values; the list "Inherited values (N)" marks them "inherited from de".
- [ ] **`vip` variation** shows the variation values where they exist.
- [ ] **Missing translations (N)** lists layers without a value; they keep the source text; **Select** / **Select all missing** select and zoom to them.
- [ ] **Show key names instead of text** previews `[key_name]`.
- [ ] **Restore exactness:** preview, then Reset, on text with a text style, a colour style and a hyperlink: text, styles and link are exactly as before (for a field-by-field check run T5).
- [ ] Text bound to a **string variable** is skipped and reported ("Text comes from a Figma variable…").
- [ ] A layer with a **missing font** is reported and left unchanged.
- [ ] **Edited during preview:** preview, edit a previewed layer, Reset → "N layers were edited during preview." → **Keep current text** keeps the edit; **Restore original** restores the original.
- [ ] **Hidden instance child:** preview, then hide a previewed text through a variant or boolean property, Reset page, show it again → the original text is back.
- [ ] **Duplicate a previewed frame:** the copy is not treated as previewing (no Preview badge); Reset leaves the copy's text alone.
- [ ] **Push blocked while previewing:** Push shows "Reset previews before pushing…" with **Reset previews**; the Push button stays disabled until then.
- [ ] **Reset selection** and **Reset page** reset only their scope; the header's **Reset** resets the page.
- [ ] **Instances:** preview the main component and its instances, then Reset: both are restored. If an instance keeps Figma's override flag, the plugin says "N instances keep a text override after reset."
- [ ] **RTL** (optional): the plugin writes RTL text as is and Figma handles the direction; note how it renders.

---

## 5. Phase 2: context and handoff

- [ ] **File link:** **Paste file link** → paste the file's share link → saved; the dashboard's project Figma tab lists the file. A branch link shows "Links and screenshots sync after this branch is merged."
- [ ] **Screenshots and links in the dashboard:** with "Upload screenshots on push" on, push → the key's **Design** tab shows the frame screenshot with the layer's box highlighted; **Open in Figma** opens that frame. Replacing a screenshot shows the new image.
- [ ] Key list: the design filter and the row chip work; `?key=<keyId>` opens that key.
- [ ] **Dev Mode inspect:** select linked text → key name with Copy, status, max length, values for every language (Draft/Published), inherited/missing markers, snippet for the chosen platform with Copy, **Open in ReRune**. Not signed in → sign-in works in Dev Mode. File not connected → "This file isn't connected to ReRune yet. A designer connects it from Figma Design."
- [ ] **Codegen:** Dev Mode → Code → each of React (i18next), Flutter, Android, iOS, Angular shows the snippets of the selected keys; a container with many keys stops at 50 with "More keys not shown"; unlinked → "No ReRune key is linked to this layer."
- [ ] **MCP:** `get_keys_for_figma_url` with the frame's URL returns its keys.
- [ ] **Branch safety:** create a branch, add frames in the main file, run page link sync in the branch → sync is paused and the main file's links survive.
- [ ] **Duplicated file:** duplicate the file → the copy banner "This may be a copy of another file…" shows and sync stays paused until **This is the same file** or a new link is pasted.
- [ ] **Deleted layer:** delete a linked layer, run link sync → "N links point to layers not in this file" with **Remove**; the link is removed only through Remove.
- [ ] Sandbox user: no "Upload screenshots on push" option.

## 6. Phase 3: QA

- [ ] **Overflow report** in `de` and `it` on Chapter lists clipped, truncated and parent-overflowing layers with Select/Zoom; the canvas is reset afterwards.
- [ ] **Pseudo-localization** previews accented, expanded text and resets.
- [ ] **Language copies:** duplicate a frame per language → copies sit next to the original (inside the same section), named "<frame> · <lang>", excluded from scans and pushes; a component set is refused with "Language copies work on frames…"; refused while previews are active.
- [ ] **ICU plural selector:** sample values and plural categories render a plural key correctly per language.
- [ ] **max_length:** warnings in Layers, Push (blocking updates) and Preview.

---

## 7. Browser Figma and Figma for VS Code

Run Design-mode checks in browser Figma and Dev Mode checks in Figma for VS Code. Record how the build was loaded (imported development build, or a published build after §9).

- [ ] **Open external:** Sign in with ReRune, Open browser again, Create an account and Open ReRune (quota) open the system browser.
- [ ] **Clipboard:** Copy in the inspect panel and Copy report in Diagnostics put the text on the clipboard.
- [ ] VS Code: the inspect panel works at its narrow width; T10 shows `"vscode": true`.
- [ ] Browser Figma has its own plugin storage: sign in once there.

---

## 8. Spike questions

### 8.1 Running diagnostics

- **Design mode:** Settings → Advanced → **Diagnostics** (also on the Sign in screen, so it works without signing in). All builds.
- **Dev Mode (development builds):** the inspect panel shows a **Diagnostics** button (read tests, T9 and the Network check).
- **Codegen (development builds):** Dev Mode → Code → language **ReRune diagnostics** (T6).
- Each report has **Copy report**; paste it under [Spike reports](#spike-reports).

| Test | How to run it | Look at |
|---|---|---|
| T1 Mark / T1 Check markers | Select a few text layers (one inside an instance) → **T1 Mark**. Then, in turn: duplicate a marked layer; copy/paste it within the file; paste it into another file; detach the instance; create a branch, mark text there and merge it. After each step run **T1 Check markers** on that page (in the other file too). | per node `sameId`, `instancePattern`, `matchedByCriteria`; `found` vs the layers you expect |
| T2 Instances | Link the component's text (§3), then select a direct instance, the nested instance and the library instance → **T2 Instances** | per sublayer `hasLinkData`, `matchedByCriteria`, `classification`, `ownPluginDataOverride`, `idPatternInherited`; `textCount` vs `criteriaCount`; the `overrides` dump |
| T2 Clear inherited | Select an instance whose main text is linked → **T2 Clear inherited**, then undo twice | `clearWithEmptyString.cleared`, `ownLinkWrite.listedAsPluginDataOverride`, `ownLinkWrite.stateAfter` |
| T3 Export frame | Select an opaque frame, then a frame without fill, then a frame with a drop shadow → **T3 Export frame** | `matches` per export, `absoluteBoundingBox` vs `absoluteRenderBounds`, `opaqueBackground`, `jpgCornerPixel` of the transparent frame |
| T4 Export page | On a page with up to 100 top-level frames → **T4 Export page** | `totalMs`, `averageBytes`, `maxBytes`, `p95Bytes`, `reexported` |
| T5 Fonts and restore | Select a style-bound, a colour-style, a hyperlinked, a variable-bound and a component-property-bound text → **T5 Fonts and restore**, then check the canvas | per node `exact` (every field true?), `restoreFailures`, `boundToVariable`, `textOverriddenBefore` vs `textOverriddenAfter` |
| T6 codegen | Dev Mode → Code → **ReRune diagnostics** with a linked layer selected; then rename a layer to `sleep:2`, `sleep:5`, `sleep:14` and `sleep:16` and select each in turn | `figma.command`, `figma.mode`, `cache read ms`, `snippet build ms`; which sleep still renders (3 s vs 15 s timeout) |
| T7 File settings | After connecting a file, and again after a branch merge → **T7 File settings** | `root` and every loaded page: `present`, `valid`, `updatedAt`, `equalToRoot`; `current.source`, `current.differ` |
| T8 Relaunch button | Select layers → **T8 Relaunch button**, then look at the right sidebar in Design and in Dev Mode | is **Open ReRune** shown in each? |
| T9 Dev Mode write | Dev Mode, development build: select a layer → inspect **Diagnostics** → **T9 Dev Mode write** | `allowed`, `error`, `cleanupError` |
| T10 Environment | In Design and in the Dev Mode inspect panel (desktop, browser, VS Code) | `editorType`, `mode`, `command`, `vscode`, `apiVersion`, `skipInvisibleInstanceChildrenDefault`, `userAgent` |
| Network check | Any Diagnostics screen | `status`, `cors`, `latencyMs` |

### 8.2 Answers

Record the answer and the branch chosen; link the report under [Spike reports](#spike-reports).

| # | Question | Diagnostics | If yes | If no | Answer | Branch chosen |
|---|---|---|---|---|---|---|
| S1 | Does `link` survive duplicate within a file? | T1 | `copied` flow handles it | copies arrive unlinked; nothing to do | | |
| S2 | Survives copy/paste within file / into another file? | T1 | same | same | | |
| S3 | Do instance sublayers (direct, nested, library) inherit main-component data; does the criteria filter match them; is a sublayer `setSharedPluginData` listed as a `pluginData` override? | T2 Instances, T2 Clear inherited | `inherited` state stands; overrides rule is primary | instances need their own links; document. If writes are not listed, rely on the id-pattern fallback for duplicated instances (record the choice) | | |
| S4 | Does writing `""` clear inherited data? | T2 Clear inherited | no tombstone needed | tombstone path (already implemented) | | |
| S5 | Does root `file` survive branch merge? Page mirror? | T7 | — | rely on page mirror (implemented) | | |
| S6 | Does `useAbsoluteBounds: true` image size equal `absoluteBoundingBox × scale`? | T3 | boxes exact | UI rescale path (implemented); file an issue if origins shift | | |
| S7 | JPG of a transparent frame: background colour? | T3 | — | PNG path (implemented) | | |
| S8 | 100-frame export time and sizes | T4 | — | lower default scale if p95 > 2 MB | | |
| S9 | Codegen timeout 3 s or 15 s; `figma.command`/`mode` in inspect and codegen | T6, T10 (inspect) | — | — | | |
| S10 | `setSharedPluginData` in Dev Mode | T9 | stays unused | stays unused | | |
| S11 | Relaunch buttons in Dev Mode | T8 | — | — | | |
| S12 | Component-property-bound text: direct write OK? Style/variable bindings restored exactly? Override flag cleared after restore? | T5 | — | use `instance.setProperties` (follow-up); keep `override_kept` reporting | | |
| S13 | Figma agent with ReRune MCP as a custom connector (header auth) can link a frame's text to keys | manual | document in `/docs/figma` "AI agents" | omit | | |
| S14 | Does the imported plugin (`editorType ["figma","dev"]`, `inspect` + `codegen`) appear in (a) the Design plugins menu, (b) the Dev Mode inspect panel plugin list, (c) the Dev Mode Code section language dropdown — on desktop, browser and VS Code? | manual | keep the manifest | if (c) fails: drop `codegen` and `codegenLanguages` (snippets stay in the inspect panel). **Do not submit to Community until S14 is answered.** | | |

S14 checklist:

| Surface | (a) Design plugins menu | (b) Dev Mode inspect plugins | (c) Dev Mode Code language dropdown |
|---|---|---|---|
| Desktop (macOS) | | | |
| Desktop (Windows) | | | |
| Browser | | | |
| VS Code | — | | |

---

## 9. Production acceptance

After the server and dashboard PRs are merged and deployed (server first, with `FIGMA_CONNECT_URL` and `DESIGN_STORAGE_*`; then the dashboard), and before the Community submission.

- [ ] 1. Server deployed with `FIGMA_CONNECT_URL=https://rerune.io/figma/connect` and `DESIGN_STORAGE_*`; dashboard deployed after it.
- [ ] 2. `npm run build` (API `https://rerune.io/api`), imported in Figma desktop and in browser Figma.
- [ ] 3. Diagnostics → **Network check**: `"status": 200`, `"cors": "ok"` through nginx. Forced 429: run the command below and check that a `429` response carries `Retry-After` and `Access-Control-Expose-Headers: Retry-After`:

  ```bash
  for i in $(seq 1 70); do curl -s -o /dev/null -D - -H 'Origin: null' https://rerune.io/api/figma/meta | grep -iE '^(HTTP|retry-after|access-control-)'; done | sort | uniq -c
  ```

- [ ] 4. Pairing against production on the same network, and once from a phone on mobile data (typed-code mode); the connection email arrives and **Review connected apps** opens Profile.
- [ ] 5. Push a draft, preview a language, upload a screenshot, open it in the dashboard's Design tab (the signed URL loads), replace it, and check that the old object is deleted from the Storage zone within an hour (write-ahead row) or at once (replacement row).
- [ ] 6. Results recorded below. Only then submit to Figma Community.

| Date | Step | Result | Notes |
|---|---|---|---|
| | | | |

---

## Results log

| Date | Tester | OS | Figma (desktop/browser/VS Code + version) | Plugin commit and build | Server / dashboard commit | Sections passed | Issues |
|---|---|---|---|---|---|---|---|
| | | | | | | | |

## Spike reports

Paste each report as a fenced JSON block under a heading with the test, date and surface, e.g. `### T2 Instances, 2026-11-03, desktop macOS`.
