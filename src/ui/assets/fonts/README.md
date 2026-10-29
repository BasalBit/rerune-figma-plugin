# Bundled fonts

The plugin UI's fonts, bundled into `build/ui.js` as bytes (`build-figma-plugin.ui.js` loads `.woff2` as binary) and
registered with `FontFace` by `src/ui/brand/fonts.ts`. Nothing is fetched at runtime. All three are under the SIL Open
Font License 1.1 (`OFL-*.txt`); `fonts.ts` repeats the copyright lines and the licence in a `/*! */` comment, which
the build keeps in `build/ui.js`.

| File | CSS family | Source | Glyphs | Bytes | SHA-256 |
|---|---|---|---|---|---|
| `inter-latin-wght.woff2` | `Inter` (the family Create Figma Plugin's `--font-family` asks for) | Inter 4.001, `@fontsource-variable/inter@5.3.0` `files/inter-latin-wght-normal.woff2`, unmodified (variable, wght 100–900). © 2016 The Inter Project Authors | 518 | 48,256 | `3100e775e8616cd2611beecfa23a4263d7037586789b43f035236a2e6fbd4c62` |
| `ibm-plex-mono-latin-500.woff2` | `ReRune Mono` | IBM Plex Mono Medium 2.3, `@fontsource/ibm-plex-mono@5.3.0` `files/ibm-plex-mono-latin-500-normal.woff2`, unmodified (IBM reserves the name "Plex"; the file is not changed). © 2017 IBM Corp. | 280 | 14,888 | `01d285447409c8a588692162439a038b8cbd7871309ee20267b0d2d91c6e8e22` |
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

Inter and Plex Mono are the fontsource Latin subsets: user text in Cyrillic, Greek, Arabic or CJK, and `→`, fall back
to the system fonts per glyph, as before.
