const LINE_SEPARATOR = new RegExp(String.fromCharCode(0x2028), "g")
const PARAGRAPH_SEPARATOR = new RegExp(String.fromCharCode(0x2029), "g")

export function serializeUiData(data: Record<string, unknown>): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(LINE_SEPARATOR, "\\u2028")
    .replace(PARAGRAPH_SEPARATOR, "\\u2029")
}

export function showPluginUI(options: ShowUIOptions, data: Record<string, unknown>): void {
  const html =
    `<div id="create-figma-plugin"></div><script>document.body.classList.add('theme-${figma.editorType}');` +
    `const __FIGMA_COMMAND__='';const __SHOW_UI_DATA__=${serializeUiData(data)};${__html__}</script>`
  figma.showUI(html, { themeColors: true, ...options })
}
