import { BRAND_TOKENS, COLOR_MIX_FALLBACK, FONT_TOKENS, TINT_BORDER_PERCENT, TINT_PERCENT, type BrandToken, type Theme } from "./tokens"

// The plugin's one stylesheet: brand tokens for Figma light and dark, the focus ring, and the rr-* component classes
// (inline styles cannot do ::before, :focus-visible or media queries). GlobalStyle puts it in the page. Surfaces,
// controls and semantic hues stay Figma's (--figma-color-*); the ReRune layer is identity, data and states.
// No url(), no @import, no network: fonts are registered from bundled bytes (fonts.ts). The rules are written
// compact (they ship in ui.js as they are written).

const SUPPORTS_MIX = "@supports (background:color-mix(in srgb,red 50%,blue))"

function declarations(theme: Theme, values: (token: BrandToken) => string): string {
  return (Object.keys(BRAND_TOKENS) as BrandToken[]).map((token) => token + ":" + values(token)).join(";")
}

function themeBlock(selector: string, theme: Theme): string {
  // A custom property holding color-mix() is only checked where it is used, so browsers without color-mix get the
  // fallback value and the color-mix one only inside @supports.
  const plain = declarations(theme, (token) => COLOR_MIX_FALLBACK[token]?.[theme] ?? BRAND_TOKENS[token][theme])
  const mixed = (Object.keys(COLOR_MIX_FALLBACK) as BrandToken[])
    .filter((token) => BRAND_TOKENS[token][theme].startsWith("color-mix("))
    .map((token) => token + ":" + BRAND_TOKENS[token][theme])
  return selector + "{" + plain + "}" + (mixed.length > 0 ? "\n" + SUPPORTS_MIX + "{" + selector + "{" + mixed.join(";") + "}}" : "")
}

const fonts = (Object.keys(FONT_TOKENS) as (keyof typeof FONT_TOKENS)[]).map((token) => token + ":" + FONT_TOKENS[token] + ";").join("")

const tinted = (percent: number) => "color-mix(in srgb,var(--hue) " + percent + "%,var(--figma-color-bg))"

export const BRAND_CSS = [
  // tokens
  themeBlock(":root", "light"),
  themeBlock(":root.figma-dark", "dark"),
  // html:root outranks CFP's :root, which sets the code font to the system monospace.
  "html:root{" + fonts + " --font-family-code:var(--rr-font-mono)}",

  // page
  "html,body,#create-figma-plugin{height:100%}",
  "input.rr-check{-webkit-appearance:checkbox;appearance:auto;width:12px;height:12px;margin:0;flex-shrink:0;cursor:pointer;accent-color:var(--figma-color-bg-brand)}",

  // focus: CFP's base.css removes outlines on every button and input; plugin-owned controls get Figma's selection ring back
  ".rr-focus:focus-visible{outline:2px solid var(--figma-color-border-selected-strong);outline-offset:1px}",
  ":where(.rr-focus:focus-visible){border-radius:3px}",

  // type
  ".rr-wordmark{font-family:var(--rr-font-display);font-weight:800;font-size:15px;line-height:1;letter-spacing:-0.02em;white-space:nowrap;color:var(--rr-ink)}",
  ".rr-display{margin:0;font-family:var(--rr-font-display);font-weight:800;font-size:22px;line-height:1.05;letter-spacing:-0.015em;color:var(--rr-ink)}",
  ".rr-label{font-family:var(--rr-font-mono);font-weight:500;font-size:10px;line-height:14px;letter-spacing:0.08em;text-transform:uppercase;color:var(--rr-muted);overflow-wrap:anywhere}",
  ".rr-eyebrow{display:flex;align-items:center;gap:6px;margin:12px 0 6px;font-family:var(--rr-font-mono);font-weight:500;font-size:10px;line-height:14px;letter-spacing:0.08em;text-transform:uppercase;color:var(--rr-muted);overflow-wrap:anywhere}",
  ".rr-eyebrow::before{content:\"\";width:12px;height:2px;border-radius:1px;background:var(--rr-amber);flex:none}",
  ".rr-code{font-family:var(--rr-font-mono);font-weight:500}",

  // text links: ink with an amber underline
  ".rr-link{background:none;border:0;padding:0;margin:0;font-family:var(--font-family);font-weight:500;font-size:11px;line-height:16px;color:var(--rr-ink);text-align:left;cursor:pointer;",
  "text-decoration-line:underline;text-decoration-thickness:1px;text-decoration-color:var(--rr-accent);text-underline-offset:3px}",
  ".rr-link:hover:not(:disabled){text-decoration-color:currentColor}",
  ".rr-link:disabled{opacity:0.5;cursor:default}",
  ".rr-link--danger{color:var(--figma-color-text-danger);text-decoration-color:currentColor}",

  // header, brand, tabs, preview band
  ".rr-header{display:flex;align-items:center;gap:8px;min-height:22px;padding:8px 12px 4px}",
  ".rr-brand{display:inline-flex;align-items:center;gap:6px;flex:none;color:var(--rr-ink)}",
  ".rr-brand__tile{display:grid;place-items:center;flex:none;width:22px;height:22px;border-radius:6px;border:1px solid var(--rr-ink);background:var(--rr-mark-bg);color:var(--rr-ink)}",
  ".rr-divider{flex:none;width:1px;height:14px;background:var(--figma-color-border)}",
  ".rr-project{flex:1;min-width:0;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
  "@media (max-width:339px){.rr-header .rr-wordmark,.rr-header .rr-narrow-hide{display:none}}",
  ".rr-tabs{display:flex;padding:0 8px}",
  ".rr-tab{background:none;border:0;border-bottom:2px solid transparent;padding:6px 8px;font-family:var(--font-family);font-size:11px;line-height:16px;font-weight:400;color:var(--rr-muted);cursor:pointer}",
  ".rr-tab[aria-selected=\"true\"]{color:var(--figma-color-text);font-weight:600;border-bottom-color:var(--rr-accent)}",
  ".rr-tab:disabled{opacity:0.5;cursor:default}",
  ".rr-band{display:flex;align-items:center;gap:8px;padding:4px 12px;background:var(--rr-wash);font-size:11px;line-height:16px}",
  ".rr-band::before{content:\"\";flex:none;width:6px;height:6px;border-radius:50%;background:var(--rr-accent)}",

  // chips and notes: one recipe; --hue is the tone's colour, the text stays Figma's
  ".rr-chip{--hue:var(--rr-muted);display:inline-flex;align-items:center;gap:4px;height:16px;padding:0 6px 0 5px;border-radius:999px;border:1px solid var(--figma-color-border);",
  "background:var(--figma-color-bg-secondary);color:var(--figma-color-text);font-family:var(--font-family);font-weight:500;font-size:10px;line-height:14px;white-space:nowrap;flex-shrink:0}",
  ".rr-note{--hue:var(--figma-color-text-brand);display:flex;align-items:flex-start;gap:8px;padding:8px;border-radius:6px;border:1px solid var(--figma-color-border);background:var(--figma-color-bg-secondary);color:var(--figma-color-text)}",
  ".rr-note__main{flex:1;min-width:0;display:flex;flex-direction:column;gap:6px}",
  ".rr-note__body{font-size:11px;line-height:16px;overflow-wrap:anywhere}",
  ".rr-note__icon{flex:none;display:grid;place-items:center;color:var(--rr-ink)}",
  ".rr-note__actions{display:flex;gap:6px;align-items:center;flex-wrap:wrap}",
  ".rr-tone--good{--hue:var(--figma-color-text-success)}",
  ".rr-tone--info{--hue:var(--figma-color-text-brand)}",
  ".rr-tone--warning{--hue:var(--figma-color-text-warning)}",
  ".rr-tone--danger{--hue:var(--figma-color-text-danger)}",
  ".rr-tinted{border-color:var(--hue)}",
  SUPPORTS_MIX + " { .rr-tinted { background: " + tinted(TINT_PERCENT) + "; border-color: " + tinted(TINT_BORDER_PERCENT) + "; } }",
  ".rr-tone--rerune{--hue:var(--rr-accent);background:var(--rr-wash);border-color:var(--rr-amber)}",
  ".rr-chip.rr-tone--neutral{color:var(--rr-muted)}",
  ".rr-glyph{flex:none;width:6px;height:6px;border-radius:50%;background:var(--hue)}",
  ".rr-glyph--triangle{width:7px;border-radius:0;clip-path:polygon(50% 0,100% 100%,0 100%)}",
  ".rr-glyph--diamond{width:5px;height:5px;border-radius:1px;transform:rotate(45deg)}",
  ".rr-glyph--ring{background:none;border:1px solid var(--hue)}",

  // key tag: data only, a real key name in mono between amber brackets (empty alt text: screen readers read the name)
  ".rr-key{display:inline-block;max-width:100%;padding:1px 5px;border-radius:4px;border:1px solid var(--rr-key-line);background:var(--rr-key-bg);",
  "color:var(--rr-ink-2);font-family:var(--rr-font-mono);font-weight:500;font-size:10.5px;line-height:14px;overflow-wrap:anywhere;text-align:left;vertical-align:middle}",
  ".rr-key::before{content:\"\\2039\";content:\"\\2039\" / \"\";margin-right:3px;color:var(--rr-accent)}",
  ".rr-key::after{content:\"\\203A\";content:\"\\203A\" / \"\";margin-left:3px;color:var(--rr-accent)}",
  ".rr-key--pending{border-style:dashed}",
  ".rr-key--lg{font-size:12px;line-height:16px}",

  // word tile: an amber tile behind the last word of a heading (the word stays brand ink)
  ".rr-tile{position:relative;z-index:0;display:inline-block;color:var(--rr-brand-ink)}",
  ".rr-tile::before{content:\"\";position:absolute;z-index:-1;left:-0.07em;right:-0.07em;top:0.1em;bottom:-0.02em;border-radius:0.07em;background:var(--rr-amber);transform:rotate(-1.4deg)}",

  // postage stamp: radial-gradient perforation, the mark in white on the brand ink window
  ".rr-stamp{--r:3px;--sbg:var(--rr-stamp-paper);position:relative;display:inline-block;flex:none;padding:calc(var(--r) * 2.1);",
  "background:radial-gradient(var(--r),#0000 96%,var(--sbg)) round calc(-1.5 * var(--r)) calc(-1.5 * var(--r)) / calc(3 * var(--r)) calc(3 * var(--r)),",
  "linear-gradient(var(--sbg) 0 0) no-repeat 50% / calc(100% - 3 * var(--r)) calc(100% - 3 * var(--r));",
  "filter:drop-shadow(0 2px 3px rgba(15,23,41,0.22))}",
  ".figma-dark .rr-stamp{filter:drop-shadow(0 2px 4px rgba(0,0,0,0.55))}",
  ".rr-stamp__art{display:grid;place-items:center;background:var(--rr-brand-ink);color:#ffffff}",
  ".rr-stamp--sm{transform:rotate(-4deg)}",
  ".rr-stamp--sm .rr-stamp__art{width:22px;height:26px}",
  ".rr-stamp--md{transform:rotate(4deg)}",
  ".rr-stamp--md .rr-stamp__art{width:40px;height:46px}",

  // postmark: the one piece of motion, beside a clean result
  ".rr-postmarked{position:relative;padding-right:56px;min-height:52px}",
  ".rr-postmark{position:absolute;right:6px;top:50%;color:var(--rr-postmark);opacity:0.78;pointer-events:none;transform:translateY(-50%) rotate(-8deg);animation:rr-stamp-in 180ms ease-out both}",
  "@keyframes rr-stamp-in{from{opacity:0;transform:translateY(-50%) rotate(-8deg) scale(1.12)}to{opacity:0.78;transform:translateY(-50%) rotate(-8deg) scale(1)}}",
  "@media (max-width:319px){.rr-postmark{display:none}.rr-postmarked{padding-right:8px;min-height:0}}",

  // ticket: the pairing code card of /figma/connect
  ".rr-ticket{position:relative;display:flex;flex-direction:column;background:var(--figma-color-bg);border:1px solid var(--rr-ink);border-radius:8px;box-shadow:3px 3px 0 var(--rr-hard);text-align:center}",
  ".rr-ticket__main{display:flex;flex-direction:column;align-items:center;gap:6px;padding:14px 12px 12px}",
  ".rr-ticket__stub{position:relative;display:flex;flex-direction:column;align-items:center;gap:2px;padding:8px 12px 10px;border-top:1px dashed var(--rr-key-line)}",
  ".rr-ticket__stub::before,.rr-ticket__stub::after{content:\"\";position:absolute;top:-7px;width:12px;height:12px;border-radius:50%;background:var(--figma-color-bg);border:1px solid var(--rr-ink)}",
  ".rr-ticket__stub::before{left:-7px;clip-path:inset(0 0 0 50%)}",
  ".rr-ticket__stub::after{right:-7px;clip-path:inset(0 50% 0 0)}",
  ".rr-pairing-code{font-family:var(--rr-font-mono);font-weight:500;font-size:30px;line-height:1;letter-spacing:0.12em;margin-right:-0.12em;padding:4px 0;color:var(--rr-ink)}",

  // empty state: a small stamp beside the hint
  ".rr-empty{display:flex;align-items:center;gap:12px;padding:12px 4px}",
  ".rr-empty__text{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;font-size:11px;line-height:16px}",
  ".rr-empty__title{font-weight:600;font-size:12px;color:var(--figma-color-text)}",
  ".rr-empty__hint{color:var(--rr-muted)}",
  ".rr-empty__action{margin-top:4px}",

  // motion and forced colours
  "@media (prefers-reduced-motion:reduce){.rr-postmark{animation:none}}",
  "@media (forced-colors:active){.rr-tab[aria-selected=\"true\"]{border-bottom-color:CanvasText}.rr-brand__tile,.rr-key,.rr-ticket{border-color:CanvasText}}",
].join("\n")
