# Manual testing

Figma has no emulator, so everything that depends on real Figma behaviour is tested by hand: in the **Figma desktop app** on macOS and Windows, and, once the plugin is published, in **browser Figma** and in **Figma for VS Code** (Dev Mode, which needs a paid Figma plan). Figma runs a plugin in development (imported from `manifest.json`) only in the desktop app, so every check before publishing runs there; browser Figma and Figma for VS Code are checked on the published Community build (§7, §10). Unit tests (`npm test`) cover the logic around it.

How to use this file:

- Work through the sections in order. Sections 0–4 and the spike questions (§8) are Phase 1; §5 needs the Phase 2 features and §6 the Phase 3 features.
- Tick a box when the expected result happened. When it didn't, leave it unticked, add a line under it starting with **Issue:** and file a GitHub issue.
- Add one row to the [results log](#results-log) per run, and paste diagnostics reports under [Spike reports](#spike-reports).
- Diagnostics write tests (T1-mark, T2-clear, T5, T8) change the document. Run them in a scratch copy of the fixture file and undo afterwards.

**Figma plan.** Checks marked **needs a paid Figma plan** use Dev Mode (the inspect panel, the Code section, Figma for VS Code) or a team library, which the free Starter plan does not have: §5.5, §5.6, Figma for VS Code in §7, the library-component fixture (§0.6) and the checks that use it, the Dev Mode diagnostics (T6, T9 and the Dev Mode parts of T8 and T10) and the spike questions S9, S10, S11 and S14. **On the free plan:** skip them, write "not tested (free plan)" in their Answer column, and ship the design-only build (`npm run zip:design-only`, README → Build and release). Publish the full build (`npm run zip`) only after these checks pass on a paid plan with a Dev or Full seat. Checks marked **Needs a Figma Organization or Enterprise plan (branching).** create or merge Figma branches, which only those plans have (Starter and Professional do not): §5.1 **Branch link**, §5.2 **Branch safety**, the branch part of §5.3 **Off and blocked**, the branch steps of T1 and T7 and spike S5. On other plans skip them and write "not tested (no branching)"; branch files and the page mirror they fall back to are covered by unit tests. Everything else, including the §6 QA checks, works on the free plan.

**Phase 1 is done when** §0–4 pass on Figma desktop, every spike question S1–S14 has an answer and a chosen branch (on the free plan the questions that need a paid Figma plan stay open, and the release is the design-only build; without an Organization or Enterprise plan S5 stays open too and the page mirror it falls back to is in place), the full round trip works on the Chapter design (88 keys, 7 languages, plus `de-AT` added for the test), and a page with more than 500 text layers scans without freezing Figma.

**Phase 2 is done when** §5 passes on Figma desktop against the Phase 2 server and dashboard (with design storage on), the dashboard checks (§1.1, §5.4) pass in English, German and Italian, and the Dev Mode checks (§5.5, §5.6) pass in Figma desktop (browser Figma and Figma for VS Code follow on the published build, §7 and §10). The Dev Mode checks need a paid Figma plan; on the free plan skip them and ship the design-only build.

**The Phase 3 QA features are done when** §6 passes on Figma desktop on Chapter: the overflow report in `de` and `it` (with pseudo-localization), language copies, sample values and the plural selector, and the max length warnings. These checks need no Dev Mode, so a free Figma plan is enough.

---

## 0. Setup

### 0.1 Plugin ID

Figma keys `clientStorage` (sign-in, preferences, codegen cache) by the plugin ID. The real ID, `1697181748239106841`, was created in Figma desktop on 2026-10-28 and is set in `package.json` → `figma-plugin.id`. Keep it.

- [ ] `manifest.json` (after `npm run build:dev`) has `"id": "1697181748239106841"`.

### 0.2 Build and import

```bash
npm ci
npm run build:dev    # or: npm run watch (rebuilds on change)
```

- [ ] `manifest.json` exists in the repo root and its `codegenLanguages` end with **ReRune diagnostics** (development builds only).
- [ ] Figma desktop → **Plugins → Development → Import plugin from manifest…** → pick `manifest.json` in this repo. **ReRune** now shows under Plugins → Development.
- [ ] Design-only build (the release on the free plan): `RERUNE_ENV=development RERUNE_DEV_MODE=off npx build-figma-plugin` writes a `manifest.json` with `"editorType": ["figma"]` and no `capabilities` or `codegenLanguages`. Run ReRune again: it works in Figma Design as before (on a paid plan, Dev Mode no longer lists it; import the manifest again if it still does). Run `npm run build:dev` afterwards to get the full development build back.

The development build calls the API at `http://localhost:8080` and opens the dashboard at `http://localhost:3000` (`devAllowedDomains` allows the local API for imported plugins only). `npm run build` writes a production `manifest.json` over it (API `https://rerune.io/api`), so run `npm run build:dev` again before going back to local testing. After a rebuild, re-run the plugin (⌥⌘P on macOS, Ctrl+Alt+P on Windows) or turn on **Plugins → Development → Hot reload plugin**.

### 0.3 Local server and dashboard

Server (`rerune-server`; before the merge use the `rerune-server-figma` worktree), with Mongo (replica set) and Keycloak running as usual:

- [ ] `.env` from `env_sample.txt`, with `HASH_SECRET` set and `FIGMA_CONNECT_URL=http://localhost:3000/figma/connect`. Without it, **Sign in with ReRune** ends with "Sign-in with ReRune isn't available right now. Try again later." and the server logs an error at startup.
- [ ] `/figma/` routes allow every origin, so `CORS_ALLOWED_ORIGINS` needs no entry for the plugin. Never add `null` to it.
- [ ] For the sandbox tests set `SANDBOX_ENABLED=true`.
- [ ] For the screenshot tests (§5) set `DESIGN_STORAGE_ENABLED=true` and the other `DESIGN_STORAGE_*` values (storage zone, access key, pull zone URL and token key; see the server's `docs/runbooks/design-storage.md`). With storage off, **Network check** shows `"screenshots_enabled": false` and the plugin uploads no images.
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
- [ ] An instance of a **library component** (publish a second file as a library, use its component here). **Needs a paid Figma plan** (team libraries): on the free plan leave it out and skip the library parts of §3, §4, T2 and S3.
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
- [ ] **Account without access to the file's project.** In a file already connected to Chapter, sign in and approve as an account that is not a Chapter member: the plugin still shows "Signed in as {email}" first. **Continue** → the Project screen says "This file's ReRune project isn't available to {email}. Choose a project."
- [ ] **Connection email** ("Figma plugin connected": "The ReRune Figma plugin was connected to your account at …") arrives after a successful sign-in; **Review connected apps** opens Profile.
- [ ] **Sandbox user.** Pairing works, the connect page says "This connection ends when your sandbox ends.", no connection email is sent, and (Phase 2) Settings has no "Upload screenshots on push" option.
- [ ] **Revoke in Profile** (Profile → Connected apps → Revoke → confirm): the plugin's next call ends on the Sign in screen with "Your session ended. Sign in again."
- [ ] **Sign out in the plugin** (Settings → Account → Sign out, or Sign out on the Project screen): the connection is gone from Profile → Connected apps.
- [ ] **Password reset** of the signed-in user: the plugin is signed out on its next call.
- [ ] **Cancel** on the Pairing screen returns to Sign in; **Open browser again** opens the same connect link again.
- [ ] Closing and reopening the plugin keeps you signed in. (Browser Figma has its own plugin storage; that is checked on the published build, §10.)

### 1.1 Connect page and Connected apps (dashboard)

The dashboard side of sign-in, including the behaviours added in its review rounds. Use the same setup; for the network failures stop the local API (or go offline in the browser's DevTools) and start it again when the step says so.

- [ ] **Deliberate click:** when the browser opens the connect page from Figma, an immediate click (for example a double-click carried over from **Sign in with ReRune**) does not approve: **Connect** stays disabled until the page has been visible and focused for a moment and you moved the mouse, pressed a key or tabbed to it. Keyboard only (Tab to **Connect**, Enter) and VoiceOver work. Switch to another window or tab and back: **Connect** is disabled again for a moment. **This wasn't me** is never delayed.
- [ ] **Blocked from another account:** start sign-in, open the link as account B and click **This wasn't me**, then open the same link as account A → "This code was blocked from another account" / "Nothing was connected. Start sign-in again in the ReRune plugin in Figma." The plugin says "Sign-in was blocked in the browser."
- [ ] **"This wasn't me" fails:** stop the API, click **This wasn't me** → "We couldn't block the request" ("Nothing is connected to your account unless you click Connect…"). Start the API, click **Try again** → "Request blocked", and the plugin says sign-in was blocked.
- [ ] **Countdown and device clock:** set the computer's clock a few minutes fast, then start sign-in. The countdown ("Code expires in N min") reaches its end early, but **Connect** stays usable: at 0 the page asks the server and shows "This code has expired" only when the server says so. Stop the API before the countdown ends: the page keeps checking (every 15 s, no error card) and shows "This code has expired" only once the server answers, or 10 minutes after the code's expiry. Set the clock back afterwards.
- [ ] **A server hiccup keeps you signed in:** stop the API and reload the connect page → "Something went wrong" with **Try again**, not a sign-in redirect. Start the API, **Try again** → back on the Connect screen, still signed in as the same user. Repeat with a sandbox user: the sandbox survives too.
- [ ] **Use another account:** on the connect page **Use another account** signs you out of the dashboard and opens `/login?figma_code=…`; sign in as another user → back on the connect page with the same code, "Connecting as {other email}".
- [ ] **Sandbox ends on the connect page:** let a sandbox expire (or end its session in Keycloak) while its connect page is open, then click **Connect** → you land on the home page with "Your sandbox has ended and its data was deleted.", not on `/login`.
- [ ] **Invalid link:** open `/figma/connect?code=ABC` → "This link isn't valid" / "Open the link from the ReRune plugin in Figma again."
- [ ] **Profile → Connected apps:** the row shows "Figma plugin", `rrf_…` with the token's last characters, and the "Connected", "Last used" and "Expires if unused" dates in the dashboard's language (switch en/de/it). "Last used" says "Never" until the plugin makes a call, and the server updates it at most once an hour. **Revoke** asks "Revoke access?" → confirm → "Access revoked". At phone width (390 px) **Revoke** stays reachable while the dates scroll.
- [ ] **German and Italian:** go through the connect page states once in German and once in Italian: text fits and reads naturally.

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
- [ ] **Create new keys:** Link dialog → **Create new key**: the suggested name follows the dominant pattern of Chapter's key names (check a few), can be edited, and is validated as you type. **Create on push** marks the row with "→ name". Nothing reaches ReRune yet. For a linked layer the section says to unlink it first (copied layers: or **New key** on the Push screen).
- [ ] **Push:** Push tab → the review lists "New text (N)", "Changed in Figma (N)" and the quota line ("N keys left on your plan"). **Push N changes** → results. In the dashboard: new keys exist as drafts in the main language, tagged `figma`, description = the frame name, a placeholder exists for every `{{x}}` in the text, nothing is published.
- [ ] **Tabs wait for a push:** while "Pushing drafts to ReRune…" shows (push 50+ new texts to see it), the Layers / Preview / Settings tabs and **Change** are disabled; the results appear on the Push tab when it ends.
- [ ] **Undo steps:** link a layer, then unlink another, then press ⌘Z/Ctrl+Z once: only the unlink is undone, the first link stays. After a push, preview a language and undo once: only the preview goes, the links written by the push stay.
- [ ] **Edit in ReRune → pull:** change a linked key's main text in the dashboard → Scan → row **Changed in ReRune** → Push tab "Changed in ReRune (N)" → **Update layers from ReRune** → layers show the new text and turn Synced.
- [ ] **Edit both → conflict:** change the same key in Figma and in ReRune → Push shows "Changed in both" with **Skip** / **Overwrite ReRune** / **Take ReRune text**; each does what it says. Change ReRune again between review and push: results show "Changed in ReRune meanwhile" with **Overwrite** and **Take ReRune text**.
- [ ] **Duplicate a linked layer** (⌘D/Ctrl+D): the copy shows **Copied** (filter "Needs attention"). **Keep copied links** / **Keep all copied links** keeps the link on the copy; on the Push tab "Copied layers" offers **Keep link** / **New key**.
- [ ] **Copied + divergent:** change the copy's text and keep its link → Push shows "Different texts on one key" with **Push this text** / **New key** / **Leave** per text.
- [ ] **Component text:** link the text in the main component → every instance lists the key with an **Instance** badge (Link dialog: "From main component"), including the nested instance. Override the text in one instance → that row is **Not linked** (Link dialog: "Text overridden") and Push offers to create or link a key for it.
- [ ] **Pull on inherited text:** change the component's key in ReRune → **Update layers from ReRune** updates the main component's text once; the instances follow and get no text override. For an instance of a library component (needs a paid Figma plan) the layer reports "Update this text in the library file".
- [ ] **Cross-file paste:** paste a linked frame into the second file, connect it to the same project, select the frame, Push (scope Selection). If the paste kept the links, the layers are listed under "Copied layers" (**Keep link**); if it dropped them, texts that exist in ReRune default to **Link to {key}** ("The same text exists in ReRune."). Either way, after pushing the dashboard's key count is unchanged (no duplicates).
- [ ] **Name taken:** create a key with a name that already exists → "Link to existing key {name}" is offered. On the Push tab it opens the Link dialog with that key: same text links directly; a different text asks **Use ReRune text** / **Keep layer text** (Keep → the row reads **Changed in Figma**, never **Changed in ReRune**).
- [ ] **Unlink:** select linked rows → **Unlink** → Not linked. Unlinking an instance sublayer that shows the component's key leaves the other instances linked.
- [ ] **Unlink a main with its instances:** select (or scan the page with) the main component's linked text and an instance's text → **Unlink** → both Not linked. Link the main again: the instance shows the key again (Link dialog: "From main component"). Rows that read **Not linked** because their text overrides the component (and unlinked rows) are not counted by **Unlink**.
- [ ] **Disabled key:** disable a linked key's draft in the dashboard → the row is **Read-only** and is never pushed.
- [ ] **Structured key** (ICU plural/select): linking it shows **Read-only**; push never overwrites it.
- [ ] **Key deleted in ReRune:** the row shows **Key missing**; Push lists it under "Keys missing in ReRune" with **Skip** / **Recreate** / **Unlink**.
- [ ] **Quota:** with the small-plan account, mark more new keys than are left → the review warns "Only N keys are left on your plan…"; after Push the results say "Your plan's key limit is reached." with **Open ReRune**, and the keys that fit were created.
- [ ] **Viewer:** the Project screen marks the project **View only**; the Push tab says "You can view this project but not edit its keys, so you can't push."
- [ ] **Relaunch button:** select a linked layer → the right sidebar shows **Open ReRune** → it opens the plugin on Layers with the selection scanned.
- [ ] **Key-name settings:** Settings → Key names → Template (e.g. `{frame}_{layer}`) and Case style change the suggestions.
- [ ] **Settings repair and page mirror:** on a page whose settings differ from the file's, Settings shows **Repair settings**; on a new page without settings it offers **Use this file's ReRune settings on this page**. The same offer appears above Layers, Push and Preview when the plugin opens on such a page; **Not now** hides it until you switch pages.
- [ ] **Different server** (needs a production sign-in, so it can wait for §9): open a file connected with the development build in a production build → the Project screen says "This file is connected to a different ReRune server. Nothing in this file changes unless you connect it to a project on this server." Picking a project asks "This file is connected to {other server}. Connect it to {project} on {this server} for everyone who opens it?"; **Cancel** writes nothing (T7 File settings unchanged), **Connect here** connects it.

Dev Mode (inspect panel and Code section) is checked in §5.

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
- [ ] **Push blocked while previewing:** Push shows "Reset previews before pushing…" with **Reset previews**; the Push button stays disabled until then. With a key changed in ReRune in scope, **Update layers from ReRune** is disabled too ("Reset previews first.").
- [ ] **Pull into an instance previewed on its own:** with the main component on another page, preview only an instance (Selection), change its key's text in ReRune, then (Layers or Push, Selection) try to update it: nothing is written, the layer reports "Reset the preview on this layer first.", and the main component keeps its text. Reset, then update: the main changes and the instance follows.
- [ ] **Reset selection** and **Reset page** reset only their scope; the header's **Reset** resets the page.
- [ ] **Instances:** preview the main component and its instances, then Reset: both are restored. If an instance keeps Figma's override flag, the plugin says "N instances keep a text override after reset."
- [ ] **Instances of a main previewed elsewhere:** preview the Components page, then open a page that holds only instances of those components (also: select only instances on a page that holds the main). The instances show the preview, count in the header, show the Preview badge, and Push says "Reset previews before pushing…". **Reset previews** (or the header's **Reset**) resets the main on the Components page and the instances follow; nothing German reaches ReRune.
- [ ] **Re-preview an instance:** select only an instance of a local or library component (its main not previewed), preview `de`, then `fr`: the instance switches to French, stays linked in Layers (not "Not linked", not "Copied", also for the library component, which needs a paid Figma plan) and Reset brings back the original.
- [ ] **Main edited during preview, instance with its own link:** link one instance's text to another key (explicit link), preview the main component (Page), edit the main's text, then Reset page → "1 layer was edited during preview." and nothing else is reported as reset; Diagnostics → T2 Instances shows no `preview` change on the instance. **Restore original** restores the main and the instance follows.
- [ ] **Double-click Reset** (header and Push): one reset runs; afterwards Diagnostics → T10 still reports `skipInvisibleInstanceChildrenNow: true`.
- [ ] **One canvas task at a time:** on a page with many text layers (or the network throttled), **Apply to page**: while "Applying preview…" shows, the other tabs and **Change** are disabled, so the QA tab's report, copies and pseudo-localization cannot start meanwhile; the header's **Reset** is disabled too. When the preview is applied, Reset page brings back every original text (no layer keeps preview text as its "original").
- [ ] **RTL** (optional): the plugin writes RTL text as is and Figma handles the direction; note how it renders.

---

## 5. Phase 2: context and handoff

Needs the Phase 2 server (files, links, screenshots, key design, URL keys) and dashboard (Design tab, key-list filter and chip, project Figma tab, `?key=` links). For the screenshot checks the server's design storage must be on (§0.3). Keep the dashboard open on the test project next to Figma: most checks look at both.

### 5.1 File link

- [ ] **File link:** in Figma, **Share → Copy link**. On a file without a link, the banner "Paste this file's Figma link (Share → Copy link)…" shows above Layers, Push and Preview; **Paste link** opens Settings → **Figma file**. Paste the link → **Save link** → "Saved to this file."; the section shows the file name and `https://www.figma.com/design/<key>/<name>`, and "Layer links are shared with ReRune…"; the dashboard's project Figma tab lists the file under its name. A link that is not a file link (for example `https://www.figma.com/community/file/…`) shows "Paste a Figma file link (Share → Copy link)." and nothing is saved. **T7 File settings** shows `current.syncPause: {"paused": false}`.
- [ ] **File link on the Project screen:** sign in on a new file, paste the link into "Figma file link (optional…)", pick the project → the file is connected with its link (no banner) and the project Figma tab lists it. An invalid link there keeps you on the Project screen with the same message.
- [ ] **Needs a Figma Organization or Enterprise plan (branching).** **Branch link:** in a branch, paste the branch's link → "This is a branch link. Links and screenshots sync after this branch is merged."; after saving, the banner says the same and Layers offers no **Sync links on this page**. The project Figma tab lists the main file (a `PUT …/files` request without `file_name`): a main file already listed keeps its name, a new row shows the file key until the main file's own link is pasted; the branch's name never appears there.
- [ ] **Duplicated file:** duplicate the file → the copy banner "This may be a copy of another file. Paste this file's link, or confirm it is the same file." shows (no **Not now**), **T7** shows `syncPause.reason: "possible_copy"`, and sync stays paused until **This is the same file** (writes the new name; the project Figma tab shows it) or a new link is pasted. Renaming the original file shows the same banner; **This is the same file** resumes sync.
- [ ] **Needs a Figma Organization or Enterprise plan (branching).** **Branch safety:** create a branch of a linked file and add frames in the main file. In the branch (which inherits the main file's settings, so its different name makes it read as a copy, or after pasting the branch link) the banner shows, Layers offers no **Sync links on this page**, link/unlink/push send no `/links` request, and the main file's links survive in the dashboard. After merging, open the main file: if it shows the branch banner, paste the main file's link in Settings → **Figma file** → **Replace link**.

### 5.2 Link sync

- [ ] **Links follow link, unlink and push:** link a layer (Link dialog or **Link exact matches**) → the key's **Design** tab in the dashboard lists the layer with its frame and page; link a main component's text → its instances on the page are listed too, also with scope **Selection** and only the main component selected (instances on other pages follow with **Sync links on this page** there); unlink it → they disappear too; **Unlink** → the layer disappears from the Design tab; push new keys → the created keys list their layers; **Keep copied links** lists the copies. The project Figma tab shows the file's last push with your name.
- [ ] **Push of component text:** on a component page, change a linked main component's text. On another page, select two instances of it (one placed after the component was linked) and push with scope **Selection** → the key's **Design** tab lists both instance layers and the main component's text layer.
- [ ] **Page link sync:** Layers → **Sync links on this page** (scans the page) → "Links on this page: N links added or updated, M links removed." or "ReRune's links match the layers on this page."; rename or move a linked layer to another frame and sync again → the Design tab shows the new names. Undo a link with ⌘Z / Ctrl+Z (the layer loses its link, ReRune keeps it) and sync → that link is removed.
- [ ] **Deleted layer:** delete a linked layer, **Sync links on this page** → "1 link points to a layer not in this file…" with the key and layer name and **Remove**; the link stays in the dashboard until **Remove** (or **Remove all N**). A hidden layer (hidden instance child, variant toggle) is not listed: link sync finds hidden layers.
- [ ] **Viewer:** with a project role without **Edit keys**, the banner says "Links aren't shared with ReRune because you can't edit keys in this project…"; linking writes plugin data only, and no `/links` request is sent (Network check / server log).
- [ ] **Key deleted in ReRune:** delete a linked key in the dashboard → the project Figma tab's link count drops by its layers and its box disappears from the frame's screenshot (other keys' boxes stay). In Figma the row reads **Key missing**; **Sync links on this page** says "1 link wasn't saved in ReRune because the key no longer exists or is a group." and ReRune lists nothing for it.

### 5.3 Screenshots

- [ ] **Screenshots and links in the dashboard:** with "Upload screenshots on push" on, push → the key's **Design** tab shows the frame screenshot with the layer's box highlighted; **Open in Figma** opens that frame. Replacing a screenshot shows the new image.
- [ ] **Upload screenshots on push** (Settings → Push, on by default; below it "Screenshots of the frames you push are uploaded to ReRune, so translators and developers see where each key is used."). Change text in two frames and push → the results show "Uploading screenshots… 1 of 2" with **Stop** while the tabs are locked, then "2 screenshots uploaded." Push the same frames again without changing them → "… (2 unchanged)." Only the frames of the layers the push changed (created, updated, linked, unlinked, given ReRune's text) are uploaded; text directly on a page or in a section has no frame and no screenshot.
- [ ] **Image format and size:** a frame with an opaque fill uploads as JPG; a frame without fill (or with a translucent fill, or frame opacity below 100 %) as PNG with a transparent background. A frame wider than 4096 px (for example 5000 × 300) arrives 4096 px wide, and a very detailed frame whose export is above 2 MB is exported smaller; in both cases the boxes in the Design tab still sit on their layers. Diagnostics **T3 Export frame** / **T4 Export page** report the sizes (S6–S8).
- [ ] **Boxes:** linked text of this project gets a box, also instance text that inherits a component's key; hidden layers, text clipped away by the frame, unlinked layers, copied links, instances that override the component's text and links to another project's keys get none.
- [ ] **Preview:** in frame A, select every linked layer but one and preview `de` (Apply to selection). Then select only the remaining layer, change its text and push (scope Selection) → the push works, and "Screenshots not uploaded (1)" lists "The frame shows a language preview. Reset previews and push again to upload it." with **1 frame**, which selects frame A. Reset, push again → the frame uploads.
- [ ] **Stop:** start a push that uploads several frames and press **Stop** → "Screenshot upload stopped. N screenshots weren't uploaded." and the tabs unlock. Stop also ends a wait after a 429 (lower the server's upload rate limit to provoke one) within a second, without sending that frame again.
- [ ] **Overwrite after a push:** link a layer before the file's link is pasted, paste the link, then change the layer's key in ReRune between review and push → results "Changed in ReRune meanwhile" → **Overwrite** → the key's **Design** tab lists the layer, and the frame's screenshot is uploaded ("1 screenshot uploaded.").
- [ ] **Take ReRune text after a push:** in one frame change two linked layers, then change one of their keys in ReRune between review and push → push uploads the frame with both Figma texts and the results show "Changed in ReRune meanwhile" for that key → **Take ReRune text** → the layer shows ReRune's text and the frame's screenshot is uploaded again ("1 screenshot uploaded."), so the key's **Design** tab shows ReRune's text, not the discarded one.
- [ ] **One push at a time:** with the network throttled (Figma desktop → Plugins → Development → Show/Hide console opens DevTools → Network → Slow 3G), press **Push** → from the first moment of the results until the screenshot upload ends or is stopped, **Review again** and the conflict choices are disabled and the tabs stay locked; nothing else starts meanwhile. While **Update layers from ReRune** runs, **Push**, **Review again** and the scope switch are disabled.
- [ ] **Off and blocked:** turn the toggle off → a push uploads nothing. On a branch (Needs a Figma Organization or Enterprise plan (branching)), a suspected copy or a file without a link, Settings says why ("Links and screenshots sync after this branch is merged.", "Screenshots wait until you confirm this file under Figma file.", "Screenshots upload once this file's Figma link is saved.") and nothing is uploaded. With the server's storage off, Settings shows "Screenshots aren't available on this ReRune server." instead of the toggle and pushes show no screenshot messages; turning storage off while the plugin is open makes the next upload stop silently (503) and Settings shows the same note.
- [ ] **Errors:** with the Bunny storage zone unreachable (wrong `DESIGN_STORAGE_ENDPOINT`), each frame shows "Screenshot upload failed. It will be retried on the next push." and the push itself is unaffected.
- [ ] **Sandbox user:** no "Upload screenshots on push" option, and a push sends no screenshot upload (no `figma_screenshot_upload` line in the server log).
- [ ] **Account not known yet:** block `…/figma/projects` in DevTools (Figma desktop → Plugins → Development → Show/Hide console → Network → right-click → Block request URL), reopen the plugin on a connected file (it opens on the workspace) and go to Settings → the Push section shows "ReRune couldn't be asked about screenshots: …" and no toggle (while the answer is still loading it says "Checking whether screenshots can be uploaded…"). Unblock the URL and push → afterwards Settings shows the toggle (non-sandbox accounts only).
- [ ] **Old images are deleted:** replace a frame's screenshot (change its text, push) → within a minute the old object is gone from the Bunny storage zone (the deletion job runs every 30 s; replaced objects are due at once). **Disconnect** the file in the project Figma tab → its images go the same way. Delete a scratch project in the dashboard → its `projects/<id>/` folder disappears from the storage zone.

### 5.4 Dashboard: Design tab, key list, project Figma tab

- [ ] **Design tab:** open the translations page, select a linked key → the details tabs read Translations, Placeholders, Metadata, **Design**, Publication. **Design** shows each screenshot with the key's layers boxed, the lines "Frame: …", "Page: …" and "Updated …", and **Open in Figma** (a new browser tab on that frame); "Linked layers" below lists the layers no screenshot shows. A key without links says "This key isn't linked to any Figma layer yet." / "Link layers to this key with the ReRune plugin in Figma."; a linked key without screenshot says "No screenshot yet. Push from Figma to add one." and lists its layers; with the server's storage off: "Screenshots aren't available on this server." and the layer list.
- [ ] **Design tab loading:** the design loads only while the **Design** tab is shown (browser DevTools → Network: no `/design` request while another tab is open). Switch quickly between two linked keys (A → B → A): A's design shows, never a spinner that stays or B's screenshots. Signed image links expire after `DESIGN_STORAGE_SIGNED_URL_TTL_SECONDS` (3600 by default; set 60 on the local server to test): leave the Design tab open past that, switch to another tab and back → the images load again. Delete an image from the storage zone by hand → the Design tab tries once more, then shows "Couldn't load this screenshot." instead of a broken image.
- [ ] **Key list:** linked keys show a layer chip with the count (hover: "Used in N Figma layers"; "Used in 1 Figma layer" for one). Filters → **Design** → "In a design" / "Not in any design" split the keys, their counts follow the other filters, and **Clear all** resets them. Translate a linked key's variation with DeepL or OpenRouter: the chip stays.
- [ ] **`?key=` links:** open `/translator/translations/<project>?key=<key>` (or **Open in ReRune** in the Dev Mode inspect panel, which needs a paid Figma plan) on a large project → the key opens in the details panel once the keys are loaded and the `?key=` stays in the URL. Click another key while the list is still loading → your choice stays. An unsaved edit on the key you were on is saved first, as when you click another key.
- [ ] **Project Figma tab** (the project's **Settings** → **Figma**, the last tab, without a Save button): each connected file with its name (links to the file in Figma), "Linked layers", "Screenshots" and "Last push" ("{date} by {name}"; the date alone after that user deleted their account; "Never" before the first push), and **Open in Figma**.
- [ ] **Disconnect** (project managers only): **Disconnect** → "Disconnect this file?" → confirm → "File disconnected"; the file, its links and screenshots are gone, and the key chips, the Design filter counts and the Design tab follow without a page reload. Layers in Figma keep their links: the next link sync or push from the plugin registers the file again. Disconnecting a file that another tab already disconnected also says "File disconnected". A member without project settings permission sees no **Disconnect**.
- [ ] **No files yet:** a project without files says "No Figma files connected yet." with the four steps of "Connect a Figma file"; the "Figma plugin" card says "Coming soon to Figma Community." with "View source on GitHub" (until the Community link is set at launch).
- [ ] **Languages:** go through the Design tab, the Design filter and the project Figma tab once in German and once in Italian (dashboard language switch); text fits and dates use the language's format.

### 5.5 Dev Mode inspect panel

**Needs a paid Figma plan:** Dev Mode needs a Dev or Full seat on a paid Figma plan. On the free Starter plan skip §5.5 and §5.6, leave S9, S10, S11 and S14 open, and ship the design-only build (`npm run zip:design-only`). On a Professional plan Figma may list only Community plugins in Dev Mode, so an imported development build might not show up there: record the plan you tested on in the results log and answer S14 (§8.2) first.

- [ ] **Dev Mode sign-in:** Dev Mode (Shift+D) → inspect panel → plugins → **ReRune** on a machine where the plugin isn't signed in (or after **Sign out**) → "See the ReRune keys of the selected layers, their values in every language and code snippets." → **Sign in with ReRune** → the browser opens the connect page; after approving, "Signed in as" with your email → **Continue** (only now the project loads; **Not me** signs out). Diagnostics shows only in development builds.
- [ ] **Not connected:** in Dev Mode on a file nobody connected → "This file isn't connected to ReRune yet. A designer connects it from Figma Design." Connect it from Figma Design (another tab or person), then **Check again** → the keys appear. A file connected with the other build's server says "This file is connected to a different ReRune server…".
- [ ] **Dev Mode inspect:** nothing selected → "Select a text layer or a frame to see its ReRune keys."; unlinked text → "No ReRune key is linked to this layer."; linked text or a frame → one card per key: the key name with **Copy** ("Copied", name on the clipboard), status (**Published** / **Modified** / **Not published**, **Disabled**), **Max N** when the key has a max length, "N layers", the layer's text, and the value in every project language with the main language first (**Source**). `de-AT` shows the `de` value with **Inherited from de**; a language without a value says **Missing**; a value over the max length shows **Too long (N)**; plural/ICU keys show **Plural/ICU**.
- [ ] **Large frame:** select a frame with more than 50 linked layers, for example a list of 30 rows of one component (two linked texts each) followed by a header and a button with their own keys → every key has a card (the header's and the button's too), and below the cards "More keys or layers not shown. Select a smaller part of the frame to see them all."; a frame with at most 50 linked layers shows no such note.
- [ ] **Draft / Published:** switch to **Published** → published values; a key never published says "This key isn't published yet."; switch back to **Draft**. Edit a value in the dashboard, select the layer again (or **Refresh**) → the new value shows.
- [ ] **Snippet:** pick each platform in the dropdown (React (i18next), Flutter, Android, iOS, Angular) → the code under **Code** follows the table below, with the key's placeholders as arguments (`t('greeting', { name })`); **Copy code** puts it on the clipboard. Close and reopen the panel → the platform is remembered. A key whose placeholders are reserved words (`{{class}}`, `{{default}}`) gets renamed variables that compile: React `t('…', { class: class_, default: default_ })`, iOS `…, class_, default_)`, Android `…, class_, default)`. A key named with a reserved word (`continue`, `new`) shows "is not a valid Dart identifier; rename the key for Flutter" in Flutter and "is not a valid Android resource name" in Android; a key named with a Kotlin-only keyword (`fun`, `when`) shows ``stringResource(R.string.`fun`)`` in Android.

  | Platform | Key without placeholders (`checkout_pay_button`) | Key with placeholders `a`, `b` (`greeting`) |
  |---|---|---|
  | React (i18next) | `t('checkout_pay_button')` | `t('greeting', { a, b })` |
  | Flutter | `AppLocalizations.of(context)!.checkout_pay_button` | `AppLocalizations.of(context)!.greeting(a, b)` |
  | Android | `stringResource(R.string.checkout_pay_button)` and the line `// Views: getString(R.string.checkout_pay_button)` | `stringResource(R.string.greeting, a, b)` |
  | iOS | `Text(NSLocalizedString("checkout_pay_button", comment: ""))` and the line `// UIKit: NSLocalizedString("checkout_pay_button", comment: "")` | `String(format: NSLocalizedString("greeting", comment: ""), a, b)` |
  | Angular | `{{ 'checkout_pay_button' \| translate }}` and the line `<!-- Transloco: {{ 'checkout_pay_button' \| transloco }} -->` | `{{ 'greeting' \| translate: { a: a, b: b } }}` |

  Strings are escaped for the platform (`"` and `\` in Swift and Kotlin, `'` and `\` in JavaScript and Angular), and Android maps `.` in a key to `_`.

- [ ] **Open in ReRune** opens `…/translator/translations/<project>?key=<key>` in the browser with that key selected.
- [ ] **Other cases:** a layer linked to a key that was deleted in ReRune → "This key no longer exists in ReRune."; a layer linked to another project's key → "Linked to a key of another ReRune project." with its name and snippet; revoke the plugin token in the dashboard Profile, then select a layer → "Your session ended. Sign in again."
- [ ] **Read-only:** using the inspect panel and the Code section never changes the file (no undo step appears; T9/S10 covers whether Figma would even allow a write).

### 5.6 Codegen (Dev Mode → Code)

**Needs a paid Figma plan** (Dev Mode, see §5.5). On the free plan skip it: the design-only build has no codegen languages.

- [ ] **Codegen:** Dev Mode → Code → each of React (i18next), Flutter, Android, iOS, Angular shows the snippets of the selected keys (React `t('…')`, Flutter `AppLocalizations.of(context)!.…`, Android `stringResource(R.string.…)` with a `// Views:` line, iOS `Text(NSLocalizedString("…", comment: ""))` with a `// UIKit:` line, Angular `{{ '…' | translate }}` with a `<!-- Transloco: … -->` line), each after a comment with the key's source text once the inspect panel (or a Figma Design session) has loaded the key. A key with a dot (`checkout.title`) maps to `R.string.checkout_title` on Android and shows "is not a valid Dart identifier; rename the key for Flutter" in Flutter. Before the inspect panel has loaded a key, the code ends with "Open ReRune in the Dev Mode inspect panel to load placeholders and texts." Rename a key in ReRune, open the inspect panel on it, then reselect the layer in the Code section → the new name shows. A frame with many keys stops at 50 with "More keys not shown"; unlinked → "No ReRune key is linked to this layer."
- [ ] **No network in codegen:** click through linked layers in the Code section and watch the server log: no request arrives (codegen reads only the file and the cache the inspect panel saved).

### 5.7 MCP (AI agents)

Connect an MCP client to the local server (`http://localhost:8080/mcp`, Streamable HTTP, header `X-API-Key` with a ReRune API key of account A; see the server's `docs/mcp/README.md`), or call the tools with `curl` (`tools/call`). Copy a frame's link in Figma: right-click the frame → **Copy/Paste as → Copy link to selection**.

- [ ] **MCP:** `get_keys_for_figma_url` with the frame's URL returns its keys: `matched: "frame"`, each key with its layers, frame name, status, placeholders and the main-language value (draft). With `languages: "de,de-AT"` and `source: "published"` the values follow (`de-AT` marked inherited from `de`). The page's link (right-click the page in the pages list → **Copy link to page**) → `matched: "page"`; the file link without `node-id` → `"file"`; a frame without linked text → `"none"` and no keys.
- [ ] **Which project:** without `project_id` the file's project is found. Switch the file to a second project you can access (Figma Design → **Change** → pick it) and link a layer there, so both projects know the file; call it again without `project_id` → an `ambiguous_project` error that names both projects; with `project_id` it answers. Switch the file back afterwards. A link of a file no project of yours knows → `figma_file_not_found`.
- [ ] **`list_figma_links`** with `project_id` and `file_key` (and `frame_id`) lists the linked layers with their key names and Figma links; `cursor` pages through more than `limit`.
- [ ] Optional (spike S13): a Figma agent with the ReRune MCP server as a custom connector gets a frame's design from Figma's MCP and its keys from `get_keys_for_figma_url`, and writes code that calls the keys.

---

## 6. Phase 3: QA

QA tab: **Apply to** selection / page, **Languages** (one checkbox per project language), **Source** Draft / Published and **Variation** for the overflow report and language copies; **Overflow report** (**Include pseudo-localization**, **Run overflow report**, **Stop**, **Copy CSV**); **Language copies** (**Make language copies**); **Pseudo-localization** with **Pseudo-localize selection** / **Pseudo-localize page** and **Reset**. Preview and QA tabs: **Sample values and plural forms** (**Edit** / **Hide**; both tabs edit the same saved samples and the same plural form). For the plural checks add a key in ReRune whose `en` value is `{count, plural, one {# item} other {# items}}` and whose `pl` value has `one`, `few`, `many` and `other` forms (for example by importing Flutter ARB files), and link a layer to it.

- [ ] **Overflow report** on Chapter (fixture: a fixed-size text box, a text with an ending ellipsis or **Max lines** 1, an auto-width label in a fixed-width button, an auto-height paragraph in a fixed-height card, one text with a drop shadow, and a key with **Max length** in the dashboard):
  - QA → **Apply to** Page, **Languages** German (de) and Italian (it), **Run overflow report**: "Checking German (de) (1 of 2)…", then "N issues found." and one table per language with "N issues · M layers checked". Rows: **Clipped** "… px past its box" (fixed box), **Truncated** "… px cut off" (ellipsis / max lines), **Outside its frame** "… px outside its frame" (button label, card paragraph), **Over max length** "N characters too long". The text with a drop shadow is not listed as **Clipped** unless its text really runs past the box. A fixed box with some spare height whose German text needs one more line is **Clipped**; a fixed box with line height 100% whose text fits its lines is not.
  - **Select** selects and zooms to the layer; **Select all (n)** selects every listed layer of that language.
  - When the report ends the canvas shows the original text again (banner "Reset N layers.", no preview status in the header); Cmd+Z history has no leftover clone layers.
  - Linked layers without a value: "N layers have no value in this language and kept the source text." They are not measured. A layer with a missing font is listed with "A font in this layer is missing…" and **Select on canvas**.
  - **Include pseudo-localization** adds a "Pseudo-localization" table (every text layer, linked or not).
  - **Copy CSV**, paste into a spreadsheet: columns Language, Issue, Amount, Unit, Layer, Frame, Key, Node ID; a layer named `=1+1` arrives as text.
  - **Stop** during the first language: the report ends after it ("Stopped before the last language.") and the canvas is still reset.
  - While the report runs the tabs and **Change** are locked (hovering a locked tab says "Wait for the overflow report to finish"; during language copies "Wait for the language copies to finish"), and Nav **Reset** and the **Keep current text** / **Restore original** buttons of an "N layers were edited during preview." note are disabled.
  - A preview in scope (Preview a language, or **Pseudo-localize page**, then **Run overflow report**): "Layers in scope show a preview. Reset previews first." with **Select on canvas**; nothing is previewed or measured. The same for instance text whose main component (also one outside the scope) shows a preview.
  - **Apply to** Selection, change the selection while the report runs: the layers it previewed are reset all the same, nothing else.
  - Values are rendered with the samples and plural form from **Sample values and plural forms**: set a sample on the QA tab (the plural form list shows the forms of the first language picked, or "Pick a language to choose a plural form."), run the report or make copies, then open Preview: the same sample and plural form are there.
  - An empty selection: "No text layers to check. Select layers, or choose Page."
- [ ] **Pseudo-localization:** QA → **Pseudo-localize page**: every text layer in scope, linked or not, shows accented, longer text inside ⟦ ⟧ ("Pay now" → "⟦Þáý ñóŵ···⟧"); `{{name}}` stays as it is. The header says "Previewing pseudo-localization on N layers · Reset" and the layers carry the Preview badge. Variable-bound text keeps its text and is counted ("N layers use a Figma variable and kept its text."). Push says "Reset previews before pushing…". **Reset page** restores text and styles exactly. Pseudo-localizing a layer that previews `de` starts from the original English text.
- [ ] **Language copies:** select two top-level frames (one inside a section, one an instance of a component), **Languages** German (de) and Italian (it), **Make language copies**:
  - Each frame gets "<frame> · de" and "<frame> · it" to its right (100 px gap, same y), in the same parent (the section frame stays inside its section), in the layers order frame, de, it. "Made 4 copies of 2 frames (N layers translated)."
  - Linked text shows the value of that language (Draft or Published as chosen, with the variation); layers without a value keep the source text and are listed: "German (de): N layers have no value and kept the source text (key_a, key_b, …)." with **Select originals**. Variable-bound text keeps its text.
  - Selecting only one text layer of a frame still copies and translates the whole frame.
  - A frame containing a main component with a hidden text layer (a variant or boolean property hides it): the copy (where the component is now an instance) is made without "This part of the copy differs from the original…"; its visible text is translated, and the hidden layer keeps the source text, as hidden layers do everywhere (scans skip them). Show it in the copy to check.
  - A component or a component set selected: "Language copies work on frames; place an instance in a frame first." A text directly on the page: "Select one or more frames with text first."
  - A preview active in one of the frames (also a hidden instance child whose main component is previewed): "Layers in these frames show a preview. Reset previews first." with **Select on canvas**; nothing is copied.
  - Layers scans skip the copies ("Skipped N in language copies"); a push never lists them; **Sync links on this page** and the link sync after a push do not send their layers to ReRune.
  - Selecting only a language copy: "Select one or more frames with text first." (its layers are not scanned). A duplicated copy (Cmd+D) is a normal frame again: its layers are scanned and it can be copied.
  - Cmd+Z removes the copies of the last frame; once more, those of the frame before.
- [ ] **Sample values:** a key with `{{name}}` previews as `[name]`. Preview → **Sample values and plural forms** → **Edit** lists the placeholders of the linked layers in scope; type `Ada` for `name`, **Apply** → the layer shows "Ada". Close and reopen the plugin: the sample is still there (it is kept per project; another project starts empty). **Clear samples** brings back `[name]`.
- [ ] **ICU plural selector:** with the plural key, **Automatic** shows the `other` form (`en`: "0 items"). The dropdown next to `count` lists only the previewed language's categories with the count each shows (`en`: one (1), other (0); `pl`: one (1), few (2), many (0), other (0,5)). Picking **few** in `pl` shows the `few` form with 2. A typed number picks its category (`pl` 22 → few) and `#` is formatted for the language (1000 → "1,000 items" in `en`, "1.000" in `de`). `de-AT` offers the categories of `de`. A category the next language does not have (few, then `en`) falls back to **Automatic**. A key imported from a Flutter ARB file with `{count, plural, =0{No items} =1{# item} other{# items}}` (ReRune stores `=0` as `zero`): in `en` **Automatic** shows "2 items", the dropdown lists zero (0), one (1), other (2), **zero** and a typed `0` show "No items". The Dev Mode inspect panel shows the same `other` form for plural values (needs a paid Figma plan).
- [ ] **max_length:** in the dashboard set **Max length** 10 on a linked key, then make the layer's text longer in Figma:
  - Layers shows "Over max length (n/10)" on the layer, and the **Too long** filter lists it.
  - Push lists the change with "Longer than the key's max length (n/10). Shorten the text before pushing." and the warning "1 change is longer than the key's max length and won't be pushed…" (**Select on canvas**); the other changes still push and this one is not sent.
  - Two layers of the key with different texts (one too long): the long variant says "Pushing this text is blocked."; a conflict with a too-long Figma text says "Overwrite ReRune is blocked."; **Take ReRune text** still works.
  - Preview lists values ReRune counts as too long under "Longer than max length (N)" with "n/10 characters" and **Select**. The editor refuses values over the limit, but file imports do not check it: with **Max length** 10 on the key, import a `de` file in which its value is longer, then preview `de` **Draft**.

---

## 7. Browser Figma and Figma for VS Code

Figma runs an imported development build only in the desktop app; browser Figma runs published plugins only (organisation-private plugins need a paid organisation plan). So this section runs on the **published Community build**, right after approval, as part of the post-publish smoke test (§10): the Design-mode checks in browser Figma, the Dev Mode checks in Figma for VS Code. Figma for VS Code is a Dev Mode surface and needs a paid Figma plan and the full build; with the design-only build run only the browser Figma checks.

- [ ] **Open external:** Sign in with ReRune, Open browser again, Create an account and Open ReRune (quota) open the system browser; in Dev Mode (also in VS Code; needs a paid Figma plan) Sign in with ReRune and **Open in ReRune** do too.
- [ ] **Clipboard:** Copy and **Copy code** in the inspect panel (needs a paid Figma plan) and Copy report in Diagnostics put the text on the clipboard.
- [ ] **Needs a paid Figma plan.** VS Code: the inspect panel works at its narrow width (Draft/Published, the platform dropdown and the key cards fit without horizontal scrolling); T10 shows `"vscode": true`.
- [ ] Browser Figma has its own plugin storage: sign in once there.

---

## 8. Spike questions

### 8.1 Running diagnostics

- **Design mode:** Settings → Advanced → **Diagnostics** (also on the Sign in screen, so it works without signing in). All builds.
- **Dev Mode (development builds):** the inspect panel shows a **Diagnostics** button (read tests, T9 and the Network check). **Needs a paid Figma plan.**
- **Codegen (development builds):** Dev Mode → Code → language **ReRune diagnostics** (T6). **Needs a paid Figma plan.**
- Each report has **Copy report**; paste it under [Spike reports](#spike-reports).

| Test | How to run it | Look at |
|---|---|---|
| T1 Mark / T1 Check markers | Select a few text layers (one inside an instance) → **T1 Mark**. Then, in turn: duplicate a marked layer; copy/paste it within the file; paste it into another file; detach the instance; create a branch, mark text there and merge it (Needs a Figma Organization or Enterprise plan (branching)). After each step run **T1 Check markers** on that page (in the other file too). | per node `sameId`, `instancePattern`, `matchedByCriteria`; `found` vs the layers you expect |
| T2 Instances | Link the component's text (§3), then select a direct instance, the nested instance and the library instance (needs a paid Figma plan) → **T2 Instances** | per sublayer `hasLinkData`, `matchedByCriteria`, `classification`, `ownPluginDataOverride`, `idPatternInherited`; `textCount` vs `criteriaCount`; the `overrides` dump |
| T2 Clear inherited | Select an instance whose main text is linked → **T2 Clear inherited**, then undo twice | `clearWithEmptyString.cleared`, `ownLinkWrite.listedAsPluginDataOverride`, `ownLinkWrite.stateAfter` |
| T3 Export frame | Select an opaque frame, then a frame without fill, then a frame with a drop shadow → **T3 Export frame** | `matches` per export, `absoluteBoundingBox` vs `absoluteRenderBounds`, `opaqueBackground`, `jpgCornerPixel` of the transparent frame |
| T4 Export page | On a page with up to 100 top-level frames → **T4 Export page** | `totalMs`, `averageBytes`, `maxBytes`, `p95Bytes`, `reexported` |
| T5 Fonts and restore | Select a style-bound, a colour-style, a hyperlinked, a variable-bound and a component-property-bound text → **T5 Fonts and restore**, then check the canvas | per node `exact` (every field true?), `restoreFailures`, `boundToVariable`, `textOverriddenBefore` vs `textOverriddenAfter` |
| T6 codegen | **Needs a paid Figma plan.** Dev Mode → Code → **ReRune diagnostics** with a linked layer selected; then rename a layer to `sleep:2`, `sleep:5`, `sleep:14` and `sleep:16` and select each in turn | `figma.command`, `figma.mode`, `cache read ms`, `snippet build ms`; which sleep still renders (3 s vs 15 s timeout) |
| T7 File settings | After connecting a file, and again after a branch merge (Needs a Figma Organization or Enterprise plan (branching)) → **T7 File settings** | `root` and every loaded page: `present`, `valid`, `updatedAt`, `equalToRoot`; `current.source`, `current.differ`, `current.syncPause` (link sync paused: no file link, branch or suspected copy) |
| T8 Relaunch button | Select layers → **T8 Relaunch button**, then look at the right sidebar in Design and in Dev Mode (needs a paid Figma plan) | is **Open ReRune** shown in each? |
| T9 Dev Mode write | **Needs a paid Figma plan.** Dev Mode, development build: select a layer → inspect **Diagnostics** → **T9 Dev Mode write** | `allowed`, `error`, `cleanupError` |
| T10 Environment | In Design and in the Dev Mode inspect panel (desktop, browser, VS Code; Dev Mode needs a paid Figma plan) | `editorType`, `mode`, `command`, `vscode`, `apiVersion`, `skipInvisibleInstanceChildrenDefault`, `userAgent` |
| Network check | Any Diagnostics screen | `status`, `cors`, `latencyMs` |

### 8.2 Answers

Record the answer and the branch chosen; link the report under [Spike reports](#spike-reports).

| # | Question | Diagnostics | If yes | If no | Answer | Branch chosen |
|---|---|---|---|---|---|---|
| S1 | Does `link` survive duplicate within a file? | T1 | `copied` flow handles it | copies arrive unlinked; nothing to do | | |
| S2 | Survives copy/paste within file / into another file? | T1 | same | same | | |
| S3 | Do instance sublayers (direct, nested, library; library needs a paid Figma plan) inherit main-component data; does the criteria filter match them; is a sublayer `setSharedPluginData` listed as a `pluginData` override? | T2 Instances, T2 Clear inherited | `inherited` state stands; overrides rule is primary | instances need their own links; document. If writes are not listed, rely on the id-pattern fallback for duplicated instances (record the choice) | | |
| S4 | Does writing `""` clear inherited data? | T2 Clear inherited | no tombstone needed | tombstone path (already implemented) | | |
| S5 | **Needs a Figma Organization or Enterprise plan (branching).** Does root `file` survive branch merge? Page mirror? | T7 | — | rely on page mirror (implemented) | | |
| S6 | Does `useAbsoluteBounds: true` image size equal `absoluteBoundingBox × scale`? | T3 | boxes exact | UI rescale path (implemented); file an issue if origins shift | | |
| S7 | JPG of a transparent frame: background colour? | T3 | — | PNG path (implemented) | | |
| S8 | 100-frame export time and sizes | T4 | — | lower default scale if p95 > 2 MB | | |
| S9 | **Needs a paid Figma plan.** Codegen timeout 3 s or 15 s; `figma.command`/`mode` in inspect and codegen | T6, T10 (inspect) | — | — | | |
| S10 | **Needs a paid Figma plan.** `setSharedPluginData` in Dev Mode | T9 | stays unused | stays unused | | |
| S11 | **Needs a paid Figma plan.** Relaunch buttons in Dev Mode | T8 | — | — | | |
| S12 | Component-property-bound text: direct write OK? Style/variable bindings restored exactly? Override flag cleared after restore? | T5 | — | use `instance.setProperties` (follow-up); keep `override_kept` reporting | | |
| S13 | Figma agent with ReRune MCP as a custom connector (header auth) can link a frame's text to keys | manual | document in `/docs/figma` "AI agents" | omit | | |
| S14 | **Needs a paid Figma plan.** Only (a) can be checked on the free plan. Does the imported plugin (`editorType ["figma","dev"]`, `inspect` + `codegen`) appear in (a) the Design plugins menu, (b) the Dev Mode inspect panel plugin list, (c) the Dev Mode Code section language dropdown — on desktop, browser and VS Code? | manual | keep the manifest | if (c) fails: drop `codegen` and `codegenLanguages` (snippets stay in the inspect panel). **Do not submit the full build to Community until S14 is answered.** On the free plan S14 stays open and the release is the design-only build, which has no Dev Mode parts. | | |

S14 checklist (columns (b) and (c) need a paid Figma plan; (a) can be checked on the free plan):

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
- [ ] 2. The build you will publish: `npm run build:design-only` for the design-only release, or `npm run build` for the full release (only after §5.5, §5.6 and S14 passed on a paid Figma plan). Both call the API at `https://rerune.io/api`. Import it in Figma desktop (an unpublished build runs only there; browser Figma follows after approval, §10).
- [ ] 3. Diagnostics → **Network check**: `"status": 200`, `"cors": "ok"` through nginx. Forced 429: run the command below and check that a `429` response carries `Retry-After` and `Access-Control-Expose-Headers: Retry-After`:

  ```bash
  for i in $(seq 1 70); do curl -s -o /dev/null -D - -H 'Origin: null' https://rerune.io/api/figma/meta | grep -iE '^(HTTP|retry-after|access-control-)'; done | sort | uniq -c
  ```

- [ ] 4. Pairing against production on the same network, and once from a phone on mobile data (typed-code mode); the connection email arrives and **Review connected apps** opens Profile.
- [ ] 5. Push a draft, preview a language, upload a screenshot, open it in the dashboard's Design tab (the signed URL loads), replace it, and check that the old object is deleted from the Storage zone within an hour (write-ahead row) or at once (replacement row).
- [ ] 6. Results recorded below. Only then submit to Figma Community (`COMMUNITY_LISTING.md` → Before you submit).

| Date | Step | Result | Notes |
|---|---|---|---|
| | | | |

---

## 10. Post-publish smoke test

Right after Figma approves the plugin, with the build that was published (installed from Figma Community, not imported):

- [ ] **Browser Figma:** open a connected file in browser Figma → run ReRune from the Community plugin. Browser Figma has its own plugin storage: sign in once there (Sign in with ReRune → confirm in the browser → "Signed in as {email}" → **Continue**); closing and reopening the plugin keeps you signed in.
- [ ] Scan the page, preview a language and **Reset**, push one change, and run the overflow report in `de` on one frame; the results match Figma desktop.
- [ ] §7 in browser Figma: open external, clipboard. Full build only (needs a paid Figma plan): the §7 checks in Figma for VS Code.
- [ ] Full build only (needs a paid Figma plan): the §5.5 **Dev Mode sign-in** check in browser Figma.

| Date | Build (design-only / full) | Figma plan and seat | Result | Notes |
|---|---|---|---|---|
| | | | | |

---

## Results log

| Date | Tester | OS | Figma (desktop/browser/VS Code + version) | Figma plan and seat | Plugin commit and build (full or design-only) | Server / dashboard commit | Sections passed | Issues |
|---|---|---|---|---|---|---|---|---|
| | | | | | | | | |

## Spike reports

Paste each report as a fenced JSON block under a heading with the test, date and surface, e.g. `### T2 Instances, 2026-11-03, desktop macOS`.
