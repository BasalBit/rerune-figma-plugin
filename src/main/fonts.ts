// Font loading with a cache keyed by family\0style (§7.14 step 3). Each loadFontAsync call costs a
// round trip even for loaded fonts, so a font is requested once per plugin run.

const loaded = new Map<string, Promise<void>>()

export function fontKey(font: FontName): string {
  return font.family + "\u0000" + font.style
}

export function clearFontCache(): void {
  loaded.clear()
}

export function loadFont(font: FontName): Promise<void> {
  const key = fontKey(font)
  let pending = loaded.get(key)
  if (pending === undefined) {
    pending = figma.loadFontAsync(font).catch((error: unknown) => {
      loaded.delete(key)
      throw error
    })
    loaded.set(key, pending)
  }
  return pending
}

function isFontName(value: unknown): value is FontName {
  return typeof value === "object" && value !== null && typeof (value as FontName).family === "string" && typeof (value as FontName).style === "string"
}

// Every font currently used by the node; an empty node reports its fontName (unless mixed).
export function nodeFonts(node: TextNode): FontName[] {
  const length = node.characters.length
  if (length === 0) {
    const fontName = node.fontName
    return fontName !== figma.mixed && isFontName(fontName) ? [fontName] : []
  }
  return node.getRangeAllFontNames(0, length)
}

export async function loadFonts(fonts: readonly unknown[]): Promise<void> {
  const unique = new Map<string, FontName>()
  for (const font of fonts) {
    if (isFontName(font)) {
      unique.set(fontKey(font), { family: font.family, style: font.style })
    }
  }
  await Promise.all([...unique.values()].map(loadFont))
}

// The node's current fonts plus the fontName of each stored segment (needed to re-apply styles).
export async function loadNodeFonts(node: TextNode, segments: readonly { fontName?: unknown }[] | null = null): Promise<void> {
  const fonts: unknown[] = nodeFonts(node)
  if (segments !== null) {
    for (const segment of segments) {
      fonts.push(segment.fontName)
    }
  }
  await loadFonts(fonts)
}
