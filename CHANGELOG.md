# Changelog

All notable changes to the ReRune Figma plugin are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

Nothing has been published to Figma Community yet. The first release will be `0.1.0` (the `version` in `package.json`) and contain the three phases below. Until Dev Mode is tested on a paid Figma plan (`TESTING.md` §5.5, §5.6 and S14), the release is the design-only build (`npm run zip:design-only`).

### Phase 3: QA and launch preparation (2026-10-28)

#### Added

- **Sample values and plural forms** (Preview and QA tabs): sample values for placeholders, kept per project on your machine, and a plural-form selector limited to the CLDR categories of the previewed language, each with the count it shows. ICU messages render with them (`=N` forms, `#` with offsets, select and choice, forms in ReRune's order). In plain values only the `{{name}}` references ReRune treats as placeholders take a sample; `{{ name }}` or `{{user.name}}` shows as typed, as in the app. A `zero`, `one` or `two` form in a language without that category (Flutter's `=0`, `=1`, `=2` as ReRune stores them) shows for exactly 0, 1 or 2, as in Flutter and i18next.
- **Pseudo-localization** (QA tab): accented, about 30–40% longer text on every text layer in scope, reset like any preview.
- **Overflow report** (QA tab): previews each chosen language (and optionally pseudo text) in turn, lists clipped, truncated and outside-its-frame text and values over the key's max length, copies the table as CSV, and resets the canvas when it ends, also after Stop or an error; the whole report is one undo step. It starts only when no layer in scope shows a preview. The reset runs in the plugin window, so keep it open until the report ends: previews left by closing it mid-report are announced the next time the plugin opens on that page ("N layers on this page still show a preview.", with **Reset page**).
- **Language copies** (QA tab): duplicates each selected top-level frame or instance once per language, next to the original and in the same parent, with that language's text. Copies are left out of scans, pushes and link sync.
- **max_length warnings** in Layers ("Over max length", filter **Too long**), Push (changes over the limit are held back) and Preview.
- **Design-only build** (`npm run build:design-only`, `npm run zip:design-only`, `RERUNE_DEV_MODE=off`): a manifest with `editorType ["figma"]` and no Dev Mode capabilities or codegen languages, for releases on which Dev Mode was not tested. It keeps no codegen cache.
- Release tooling: GitHub Actions CI (typecheck, lint, tests, both release zips as artifacts, a release check of each manifest and bundle in `scripts/check-build.mjs`), `COMMUNITY_LISTING.md`, placeholder listing images in `listing/` (made by `scripts/listing-placeholders.mjs`), this changelog.

#### Security

- Production builds open only `https://` links. `http://localhost` and `http://127.0.0.1` links open in development builds only, and the production bundle no longer contains the local-link pattern.

### Phase 2: context and handoff (2026-10-28)

#### Added

- **File link:** paste the file's Figma link once (Project screen or Settings → Figma file). Branch files and suspected file copies pause link sync and screenshot upload until the link is confirmed.
- **Link sync:** ReRune learns which layers show which key after every link, unlink and push, and on **Sync links on this page**. Links whose layer is not found are listed and removed only on request.
- **Screenshots on push** ("Upload screenshots on push", on by default): an image of each changed top-level frame with a box for every linked layer (JPG, or PNG without an opaque fill; at most 4096 px and 2 MB), uploaded one by one with progress and Stop. Never for sandbox accounts.
- **Dev Mode inspect panel:** the linked keys of the selection with status, max length and values in every project language (Draft or Published), snippets for React (i18next), Flutter, Android, iOS and Angular with **Copy code**, and **Open in ReRune**.
- **Dev Mode Code section:** the same snippets, built from the file's links and a local cache, without network calls.

#### Changed

- The real plugin ID `1697181748239106841` replaces the placeholder ID.

### Phase 1: MVP (2026-10-27)

#### Added

- **Sign in with ReRune:** pairing with the ReRune dashboard (code shown in the plugin, confirmed in the browser), "Signed in as" with **Not me**, sign out, and sign-in again after a session ends.
- **Projects:** pick the file's ReRune project; the choice is stored in the file for everyone who opens it with the plugin.
- **Layers:** scan the selection or the page in batches (hidden, locked, numeric-only and `_` layers skipped by default), link layers to keys (search, **Link exact matches**), and mark layers to create keys with names that follow the project's dominant naming pattern.
- **Push:** a review of new texts, changes made in Figma or in ReRune, conflicts, copied layers and missing keys, then drafts of the main language in ReRune. Nothing is published from Figma. Keys created from Figma count toward the plan's key limit.
- **Preview** any project language (draft or published, inherited regional values, variations) on the canvas, list missing translations, and reset to the original text and styles.
- Component and instance handling: links on main components show on their instances; overridden instance text counts as unlinked.
- **Diagnostics** (Settings → Advanced): the Figma behaviour tests T1–T10 and a Network check, each with Copy report.
- `README.md`, `TESTING.md` (manual test plan), MIT licence.
