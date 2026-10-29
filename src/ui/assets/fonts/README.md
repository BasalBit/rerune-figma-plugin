# Bundled fonts

The plugin UI's fonts, bundled into `build/ui.js` as bytes (`build-figma-plugin.ui.js` loads `.woff2` as binary) and
registered with `FontFace` by `src/ui/brand/fonts.ts`. Nothing is fetched at runtime. All three are under the SIL Open
Font License 1.1 (`OFL-*.txt`); `fonts.ts` repeats the copyright lines and the licence in a `/*! */` comment, which
the build keeps in `build/ui.js`.

| File | CSS family | Source | Glyphs | Bytes | SHA-256 |
|---|---|---|---|---|---|
| `inter-latin-wght.woff2` | `ReRune Inter` (first in `--font-family`, before an installed `Inter`) | Inter 4.001, `@fontsource-variable/inter@5.3.0` `files/inter-latin-wght-normal.woff2`: fontsource's Latin subset, variable (wght 100–900), not changed further. © 2016 The Inter Project Authors, no Reserved Font Name | 518 | 48,256 | `3100e775e8616cd2611beecfa23a4263d7037586789b43f035236a2e6fbd4c62` |
| `IBMPlexMono-Medium-Latin1.woff2` | `ReRune Mono` | IBM Plex Mono Medium 2.005, IBM's own Latin1 subset from the IBM Plex release (`@ibm/plex-mono@2.5.0` `fonts/split/woff2/IBMPlexMono-Medium-Latin1.woff2`), unchanged: an Original Version, so it keeps its name (IBM reserves the name "Plex" for modified versions). © 2017 IBM Corp. | 313 | 17,868 | `41201b658a328b9d00368215c2f1102770f80b15952ab82631e4006255e6365d` |
| `rerune-display-800.woff2` | `ReRune Display` | Bricolage Grotesque 1.001, `@fontsource-variable/bricolage-grotesque@5.3.0` `files/bricolage-grotesque-latin-standard-normal.woff2`, instanced and subset (below). © 2022 The Bricolage Grotesque Project Authors, no Reserved Font Name | 107 | 11,476 | `073c14e9feca497c297bc7e2610e3d6271f9874bb729d070b326fb6d0788a520` |

`ReRune Display` is a static instance (wght 800, wdth 88, opsz 24: the dashboard wordmark's 800 / 88%) cut to ASCII and
a few typographic marks, because it sets only the plugin's own words (the "ReRune" wordmark and the sign-in heading).
Text in other characters falls back to the next family. Made with fontTools 4.60.1 and brotli 1.1.0:

```sh
fonttools varLib.instancer bricolage-grotesque-latin-standard-normal.woff2 wght=800 wdth=88 opsz=24 -o rerune-display.ttf
pyftsubset rerune-display.ttf --flavor=woff2 --name-IDs='*' --notdef-outline --layout-features='kern,liga,calt,ss01' \
  --unicodes="U+0020-007E,U+00A0,U+2013,U+2014,U+2018,U+2019,U+201C,U+201D,U+2026" \
  --output-file=rerune-display-800.woff2
```

Inter and Plex Mono are Latin subsets. `--font-family` is `"ReRune Inter", Inter, Helvetica, sans-serif`
(`src/ui/brand/tokens.ts`), so a character the subset lacks (Polish ł ż ę, Czech ř, Turkish ğ ş, Vietnamese, Cyrillic,
Greek, `→`) comes from an installed full Inter when the designer has one, and from Helvetica (Arial on Windows)
otherwise: in that case such a word mixes two fonts, one character at a time. Plex Mono's Latin1 subset covers Western
European accents; key names and codes outside it fall back to the system monospace per glyph. The licences are in
`OFL-*.txt`; `OFL-IBMPlexMono.txt` is IBM's `LICENSE.txt` from the same release.
