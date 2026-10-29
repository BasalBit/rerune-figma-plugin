# Changelog

All notable changes to the ReRune Figma plugin are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

Changes made after `0.1.0` go here.

## [0.1.0] - not yet published

The first release of ReRune for Figma. It brings together the three development phases: the MVP (2026-10-27), context and handoff (2026-10-28), and QA and launch preparation (2026-10-28), plus screenshot freshness (2026-10-29). It is not in Figma Community yet. When it is published, this heading gets the publish date.

Until Dev Mode has been tested on a paid Figma plan (`TESTING.md` §5.5, §5.6 and spike S14), the release is the design-only build (`npm run zip:design-only`). It has everything below except the Dev Mode section, and it works on every Figma plan, including the free Starter plan, for anyone who can edit the file.

### Added

#### Sign-in and projects

- **Sign in with ReRune:** the plugin shows a code, you confirm it in the ReRune web app, and you never type a password into Figma. The plugin shows "Signed in as" with **Not me**, lets you sign out, and asks you to sign in again when a session ends.
- **Projects:** pick the file's ReRune project once. The choice is stored in the file for everyone who opens it with the plugin.

#### Layers and push

- **Layers:** scan the selection or the page. Hidden, locked, numbers-only and `_` layers are skipped by default. Link text layers to keys (search, or **Link exact matches**), or mark layers to create keys. New key names follow your project's naming pattern.
- **Push:** first review new texts, changes made in Figma or in ReRune, conflicts, copied layers and missing keys. Then the plugin saves them as drafts of the main language in ReRune. Nothing is published from Figma. Keys created from Figma count toward your ReRune plan's key limit.
- **Update layers from ReRune** (Push): writes ReRune's texts into the layers that changed in ReRune. A layer whose text was changed in Figma after the review is left alone ("This layer changed in Figma meanwhile, so ReRune's text wasn't written.").
- **Components:** links on a main component show on its instances. Instance text that was changed (overridden) counts as unlinked.
- **Max length warnings** in Layers ("Over max length", filter **Too long**), Push (changes over the key's limit are held back) and Preview.
- One canvas task runs at a time, and each action can be undone with one Undo.

#### Preview

- **Preview** any project language on the canvas: draft or published, regional languages with their inherited values, and variations. See which translations are missing, then reset to the original text and styles.
- **Sample values and plural forms** (Preview and QA tabs): give placeholders sample values (kept per project on your machine), and pick a plural form from the forms of the previewed language, each labelled with the count it shows. ICU messages (plural, select, `#`) render as they do in ReRune. In plain values only `{{name}}` references take a sample.

#### QA

- **Overflow report:** previews each chosen language in turn (and pseudo text, if you want), then lists clipped, truncated and outside-its-frame text and values over the key's max length. You can copy the table as CSV. When the report ends, also after **Stop** or an error, the original text comes back, and one Undo covers the whole report. Keep the plugin open until the report ends. If you close it early, the plugin tells you about the leftover previews the next time it opens on that page and offers **Reset page**.
- **Pseudo-localization:** shows accented text about 30–40% longer on every text layer in scope. Reset it like any preview.
- **Language copies:** makes one copy of each selected top-level frame per language, next to the original, with that language's text. Copies are left out of scans, pushes and link sync.

#### Context for translators

- **File link:** paste the file's Figma link once (Project screen, or Settings → Figma file). In a branch or a suspected copy of the file, link sync and screenshots wait until you confirm the link.
- **Link sync:** ReRune learns which layers show which key after every link, unlink and push, and when you click **Sync links on this page**. Saving the file's link in Settings, or confirming the file, shares the open page's links at once, including layers linked before the link was saved; other pages follow with **Sync links on this page**. Translators then see where each key is used. Links whose layer is gone are listed and removed only when you ask.
- **Screenshots of changed frames** ("Upload screenshots of changed frames", on by default): a push or **Update layers from ReRune** uploads an image of each top-level frame whose layers changed (the instances of an updated main component included), with a box around each linked layer, and shows progress and **Stop**. Frames hidden in Figma are not uploaded. Sandbox accounts never upload images.
- **Layer text in screenshots:** with a ReRune server that supports it, each screenshot box also records the layer's text. ReRune uses it to mark screenshots whose text no longer matches the key. Very long layers send no text. Older servers get the boxes without it.
- **Requested screenshots:** when people in ReRune ask for new screenshots of frames in the file (for example because the text in a screenshot is outdated), the plugin says "ReRune asks for new screenshots of N frames in this file." with who asked and which frames. **Update screenshots** reads those frames, brings in ReRune's changed texts for them (layers changed in Figma or in both, read-only keys and previews are left alone and reported), and uploads every requested frame that is still in the file and visible, whatever the screenshot setting says, which clears the requests. **Not now** hides the notice until a new request arrives; requested frames that are gone or hidden get **Remove request**. Upload runs from Push read the requests again afterwards.

#### Dev Mode (full build only)

Needs a paid Figma plan with a Dev or Full seat. Dev Mode is read-only.

- **Inspect panel:** the linked keys of the selection with status, max length and values in every language (Draft or Published), code snippets for React (i18next), Flutter, Android, iOS and Angular with **Copy code**, and **Open in ReRune**.
- **Code section:** the same snippets, built from the file's links and a local cache, without network requests.

#### Help and releases

- **Diagnostics** (Settings → Advanced): Figma behaviour tests and a Network check, each with Copy report.
- Two release builds with the same plugin ID (`1697181748239106841`), so a later update can switch between them: the design-only build (`npm run zip:design-only`: Figma Design only, no Dev Mode parts, no codegen cache) and the full build (`npm run zip`). GitHub Actions checks, tests and packs both on every push to `main`.
- `README.md`, `TESTING.md` (manual test plan), `COMMUNITY_LISTING.md` and the MIT licence.

### Security

- The plugin connects only to `https://rerune.io/api/`. Your plugin token stays in Figma's plugin storage on your device and is sent only to the ReRune API. It cannot publish.
- Release builds open only `https://` links. `http://localhost` and `http://127.0.0.1` links open in development builds only.
