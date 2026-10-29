# ReRune mark

The ReRune mark (the outlined R with the rune-like inner stroke of the dashboard's `public/logo.png`), traced as one
path of lines and circular arcs in the 500 × 500 frame of `logo.png`, `fill="currentColor"`, no transforms:

- `rerune-mark.svg`: the faithful master (binary IoU 0.9916 against `logo.png` at 500 px). Outline strokes 12.8, the
  rune 19.2 units. For art of 48 px and more: the listing cover and carousel (`listing/src/art.html`).
- `rerune-mark-small.svg`: the same outer outline and gaps with the strokes thickened inward (17.6 and 24 units), for
  18–47 px: the plugin header tile, the stamps, the request notice and the 128 px Community icon. The plugin carries
  only this cut (`src/ui/brand/mark.tsx`, checked against this file by `mark.test.ts`).

Below 18 px there is no mark, only the wordmark. Both crop to `viewBox="128 101 244 298"` (the glyph plus 10 units).
