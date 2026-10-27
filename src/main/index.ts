import { DATA_KEYS, DESIGN_UI_SIZE, INSPECT_UI_SIZE, PLUGIN_DATA_NAMESPACE } from "../shared/constants"
import { parseLink } from "../shared/plugin-data"
import { showPluginUI } from "./show-ui"

function linkedKeyName(node: SceneNode): string | null {
  if (node.type !== "TEXT") {
    return null
  }
  const parsed = parseLink(node.getSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.link))
  return parsed.kind === "link" ? parsed.link.k : null
}

export default function main(): void {
  if (figma.editorType === "dev" && figma.mode === "codegen") {
    figma.codegen.on("generate", ({ node }) => {
      const keyName = linkedKeyName(node)
      return keyName === null
        ? [{ title: "ReRune", language: "PLAINTEXT", code: "No ReRune key is linked to this layer." }]
        : [{ title: "ReRune keys", language: "PLAINTEXT", code: keyName }]
    })
    return
  }
  if (figma.editorType === "dev") {
    showPluginUI({ width: INSPECT_UI_SIZE.width, height: INSPECT_UI_SIZE.height }, { mode: "inspect" })
    return
  }
  figma.skipInvisibleInstanceChildren = true
  showPluginUI({ width: DESIGN_UI_SIZE.width, height: DESIGN_UI_SIZE.height }, { mode: "design", command: figma.command })
}
