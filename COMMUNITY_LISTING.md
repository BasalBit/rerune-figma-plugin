# Figma Community listing

Everything needed to publish the plugin in Figma Community: the listing text, the assets, the answers to Figma's data security disclosure and the notes for Figma's reviewers. Status: **not published yet**. Publishing happens by hand in the Figma desktop app (2FA on, BasalBit/ReRune publisher profile); see README → [Build and release](README.md#build-and-release).

| | |
|---|---|
| Plugin ID | `1697181748239106841` (`package.json` → `figma-plugin.id`; issued by Figma, never change it) |
| Name | ReRune |
| Publisher | BasalBit GmbH (ReRune) |
| Licence | MIT, source at <https://github.com/BasalBit/rerune-figma-plugin> |

## Which build to publish

Both builds have the same plugin ID, network access and page loading, so switching later is an update of the same Community plugin (users keep their sign-in and preferences).

| Build | Command | Manifest | Publish it when |
|---|---|---|---|
| **Design-only** | `npm run zip:design-only` | `editorType ["figma"]`, no `capabilities`, no `codegenLanguages` | Dev Mode has **not** been tested on a paid Figma plan. This is the default: the plugin's author is on the free Starter plan, which has no Dev Mode. |
| **Full** (with Dev Mode) | `npm run zip` | `editorType ["figma","dev"]`, `capabilities ["inspect","codegen","vscode"]`, 5 codegen languages | `TESTING.md` §5.5 (inspect panel), §5.6 (codegen) and spike S14 passed on a paid Figma plan with a Dev or Full seat. |

With the design-only build, leave out the description's Dev Mode paragraph and every Dev Mode image. Add both when an update switches to the full build.

## Listing fields

| Field | Value |
|---|---|
| Name | ReRune |
| Tagline | Link Figma text to ReRune translation keys, push copy as drafts and preview every language. |
| Category | Design tools (choose the development category only if the Publish modal no longer offers Design tools) |
| Price | Free |
| Support contact | info@basalbit.com |
| Privacy policy | https://rerune.io/privacy |
| Website and docs | https://rerune.io/figma, https://rerune.io/docs/figma |
| Source code | https://github.com/BasalBit/rerune-figma-plugin |
| Network access | Restricted: `https://rerune.io/api/` only (manifest `allowedDomains`; `devAllowedDomains` only affects imported development builds) |
| Network access reasoning | The plugin talks only to the ReRune API to sign in, search and resolve translation keys, push draft text and upload frame screenshots. |

The reasoning is the manifest's `networkAccess.reasoning`, word for word; `test/listing.test.ts` keeps the two equal.

## Description

### Design-only build (default)

> ReRune for Figma connects the text layers of your designs to the translation keys of your ReRune project.
>
> Requires a ReRune account. Designers join free on every ReRune plan.
>
> - **Link** text layers to existing keys (search, or link every layer whose text already exists in ReRune), or create new keys with names that follow your project's naming pattern.
> - **Push** new and changed copy to ReRune as drafts of the main language, after reviewing every change. Texts changed in both places wait for your decision. Nothing is published from Figma: publishing stays in ReRune, with the people allowed to publish.
> - **Preview** any project language on the canvas, draft or published, with regional languages and variations, then reset to the original text and styles.
> - **QA** before translations ship: an overflow report of clipped, truncated and overflowing text per language, pseudo-localization, language copies of frames, sample values for placeholders and plural forms, and max-length warnings.
> - **Context** for translators: once the file's Figma link is saved, ReRune shows where each key is used, and pushes can upload a screenshot of each changed frame ("Upload screenshots on push", on by default).
>
> Keys created from Figma count toward your ReRune plan's key limit. The plugin works on every Figma plan, including the free Starter plan, for anyone who can edit the file. No AI runs inside the plugin. Open source under the MIT licence.

### Add for the full build (with Dev Mode)

> - **Developer handoff in Dev Mode** (paid Figma plan with a Dev or Full seat): the inspect panel lists the linked keys of the selection with their values in every language and snippets for React (i18next), Flutter, Android, iOS and Angular; the Code section shows the same snippets. Dev Mode is read-only.

## Assets

The two images in `listing/` are **placeholders**: they have the sizes Figma asks for and say "PLACEHOLDER" on them (and in their PNG `Comment`). Replace them with real artwork before publishing, under the same file names and sizes. `node scripts/listing-placeholders.mjs` regenerates the placeholders (no dependencies). `test/listing.test.ts` checks the sizes and that an image still marked as a placeholder is the generator's output.

- [ ] Icon, 128 × 128 PNG: `listing/icon-128.png` (**placeholder**, replace)
- [ ] Cover (thumbnail), 1920 × 1080 PNG: `listing/cover-1920x1080.png` (**placeholder**, replace)
- [ ] Carousel, up to 9 images or videos (none yet). Suggested: Layers with linked keys and the **Create on push** names; the Push review with a conflict; Preview in German with the original next to it; the QA overflow report; language copies of a frame. Full build only: the Dev Mode inspect panel with snippets.
- [ ] Optional playground file: the Chapter example design (not made yet).

## Data security disclosure

Answers for Figma's data security disclosure (optional, reviewed by Figma, shown to signed-in users). They describe what the plugin and the ReRune server do today; check them again if the code changes. Items marked *BasalBit to confirm* are company facts the code cannot answer.

1. **Does the plugin use a backend you host?** Yes: the ReRune API at `https://rerune.io/api`, run by BasalBit GmbH. Core hosting is in Frankfurt, Germany (current providers: <https://rerune.io/subprocessors>).
2. **Public vulnerability disclosure process?** No formal programme yet; security reports go to info@basalbit.com. *BasalBit to confirm.*
3. **Security standards or certifications held?** None (no SOC 2 or ISO 27001 certification). *BasalBit to confirm.*
4. **Does the plugin send requests to services you don't host?** No. Figma's network access for the plugin is restricted to `https://rerune.io/api/`; the plugin has no analytics or other third-party calls. The ReRune server stores uploaded screenshots in a bunny.net Storage zone in Falkenstein, Germany (no replication); the plugin never contacts bunny.net.
5. **How are users authenticated?** By pairing with the ReRune web app: the plugin shows a code and opens `https://rerune.io/figma/connect` in the browser; the user, signed in to ReRune there, checks the code and clicks Connect; the plugin then receives a plugin token. No password is ever typed into the plugin. On another network than the plugin's, the user types the code instead of confirming a prefilled one, and the account gets an email after every new connection.
6. **How are credentials protected?** The plugin token is kept only in Figma's local plugin storage (`clientStorage`) on the user's device and is sent only as an `Authorization: Bearer` header to `https://rerune.io/api/figma/…`, never in URLs or logs. The server stores only a keyed HMAC-SHA256 hash of it. Tokens work only on the plugin's `/figma` routes, with the user's own project permissions, and cannot publish. A token ends after 90 days without use, at the latest 365 days after sign-in, on sign-out, on a password reset, or when the user revokes it under Connected apps in the ReRune profile. A user has at most 10 plugin tokens; an 11th sign-in replaces the oldest.
7. **Does the plugin store data obtained through the Figma API?** Yes, when the user acts (see 8).
8. **What, how and where?**
   - In ReRune's database (Frankfurt, Germany): texts the user pushes (stored as drafts of translation keys, with the frame name as a new key's description), and, once the file's Figma link is saved, the file's key, link and name, who pushed last, and for linked layers their layer IDs and the layer, frame and page names.
   - In the bunny.net Storage zone (Falkenstein, Germany): with "Upload screenshots on push" on (the default) and the file's Figma link saved, one image per top-level frame changed by a push, with the positions of its linked layers. A newer push replaces the image. Sandbox accounts never upload images.
   - In the Figma file (shared plugin data, stored by Figma): each linked layer's key ID, key name, project ID and a hash of its text; the original text and styles while a preview is shown; the file's ReRune server, project and Figma link; on language copies of frames, a marker with the language, source, variation and the original frame's ID; and, only when the Diagnostics write test **T1 Mark** is run, a test marker with the layer's ID and the time on the selected layers.
   - On the device (Figma `clientStorage`): the plugin token with the account's name and email, preferences (including sample values for placeholders), and, in the full build only, a cache of key names, placeholders and up to 60 characters of source text for Dev Mode's Code section (the design-only build keeps no such cache).
   - Retention: Figma data stays with its ReRune project. Deleting a key removes its links, disconnecting a file in the project's Figma settings removes the file's links and screenshots, and deleting a project removes all of its Figma data; a background job deletes removed images from storage. Details: <https://rerune.io/privacy>.
9. **Who can access it?** People who can open the ReRune project, according to their ReRune permissions (screenshots are shown in the dashboard through signed links that expire), and BasalBit for operating the service.
10. **How are updates managed?** The source is on GitHub (made public before submission, see below). GitHub Actions runs type checks, lint and tests and builds the release zips on every push to `main` and every pull request; BasalBit publishes each release by hand from the Figma desktop app with 2FA, and records it in `CHANGELOG.md`.

## Notes for Figma's reviewers

> ReRune is a localization platform for apps and websites. The plugin links Figma text layers to translation keys in a ReRune project.
>
> - **Account:** it requires a ReRune account (stated in the description). A free account works: sign up at https://rerune.io/register, verify the email, create a project with two languages (for example English and German) and add a German value to a key. In Figma: run ReRune → **Sign in with ReRune** → confirm the code in the browser → **Continue** → pick the project → **Layers** → **Page** → **Scan**. Link a layer to a key, or mark one for **Create on push** and push it from the **Push** tab; **Preview** shows German on the canvas and **Reset** restores the text. When https://rerune.io/sandbox has a free slot, a sandbox gives a ready-made demo project without signing up (it is deleted when the sandbox ends).
> - **No AI:** the plugin has no AI features and does not generate or translate text. Previews show the project's own translations.
> - **No MCP:** the plugin neither exposes nor connects to an MCP server. ReRune's MCP server is a separate, server-side product.
> - **Writes only on user action:** scans only read. The plugin changes the file only when the user clicks: link and unlink (plugin data and relaunch data on the layers), push and "Update layers from ReRune", preview, pseudo-localization and reset, the overflow report (temporary previews and a temporary measuring copy, all reset when it ends), language copies, saving settings, and the write tests under Settings → Advanced → Diagnostics. Figma's Undo reverts these changes to the file.
> - **Network:** only `https://rerune.io/api/`, only while the plugin is open. Screenshot upload happens only as part of a push the user starts, and can be turned off in Settings. To find keys that already have a layer's text, opening **Push** sends the texts of the unlinked layers in scope (and the key names the plugin suggests for them), and the Link dialog and **Link exact matches** send the texts of the selected layers, for an exact-match lookup; these lookups create nothing in ReRune.
> - **Publishing:** nothing is published from Figma; pushes create drafts that people with the publishing permission release in ReRune.
>
> Full build only: in Dev Mode the plugin is read-only (inspect panel and Code section); the Code section makes no network requests.

## Before you submit

- [ ] https://github.com/BasalBit/rerune-figma-plugin is public (it was still private on 2026-10-28): the listing's source link and answer 10 point to it.
- [ ] Production acceptance passed and recorded (`TESTING.md` §9): server and dashboard deployed, Network check and pairing against production, a push, a preview and a screenshot upload, all in Figma desktop (it is the only place an unpublished build runs).
- [ ] Build chosen (see [Which build to publish](#which-build-to-publish)). For the full build, S14 is answered in `TESTING.md` §8.2.
- [ ] The release build is the CI artifact of the commit you publish (`rerune-figma-plugin-design-only` or `rerune-figma-plugin`) or the same command run locally, placed where Figma desktop imported the plugin from and checked with `node scripts/check-build.mjs` (README → Build and release, step 2).
- [ ] Icon and cover replaced; carousel images taken from the build you publish.
- [ ] https://rerune.io/privacy and https://rerune.io/docs/figma are live, and the data security answers above still match.
- [ ] Decide how reviewers sign in (a free account as above, or a test account BasalBit creates; never commit its password).
- [ ] After approval: run the post-publish smoke test (`TESTING.md` §10: the published build in browser Figma, and in Figma for VS Code for the full build), set `figmaCommunityPluginUrl` in the dashboard, add the Community link to README → Install, and move the `CHANGELOG.md` entries under the released version.
