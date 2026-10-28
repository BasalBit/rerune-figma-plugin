import { DESIGN_UI_SIZE, INSPECT_UI_SIZE } from "../shared/constants"
import type { PluginEditorType } from "../shared/message-policy"
import { createMainBus, send, type MainBus } from "./bus"
import { registerCodegen } from "./codegen"
import { commandOf, registerHandlers, watchSelection, type MainContext } from "./handlers"
import { watchInspectSelection, type InspectWatcher } from "./inspect"
import { showPluginUI } from "./show-ui"

function attachBus(editorType: PluginEditorType, startup: MainContext["startup"], inspect: InspectWatcher | null): MainBus {
  const bus = createMainBus(editorType, __RERUNE_ENV__)
  registerHandlers(bus, {
    editorType,
    env: __RERUNE_ENV__,
    devMode: __RERUNE_DEV_MODE__,
    apiBase: __API_BASE__,
    dashboardBase: __DASHBOARD_BASE__,
    pluginVersion: __PLUGIN_VERSION__,
    startup,
    inspect,
  })
  figma.ui.onmessage = (message: unknown) => {
    void bus.dispatch(message)
  }
  return bus
}

// Mode dispatch (§7.4). One CFP entry: relaunch ("open"), inspect and codegen all arrive here (tooling map G1).
export default function main(): void {
  const startup = { skipInvisibleInstanceChildren: figma.skipInvisibleInstanceChildren, command: commandOf() }
  if (figma.editorType === "dev" && figma.mode === "codegen") {
    registerCodegen()
    return
  }
  if (figma.editorType === "dev") {
    const inspect = watchInspectSelection(send)
    attachBus("dev", startup, inspect)
    showPluginUI({ width: INSPECT_UI_SIZE.width, height: INSPECT_UI_SIZE.height }, { mode: "inspect" })
    return
  }
  figma.skipInvisibleInstanceChildren = true
  attachBus("figma", startup, null)
  watchSelection(send)
  showPluginUI({ width: DESIGN_UI_SIZE.width, height: DESIGN_UI_SIZE.height }, { mode: "design", command: commandOf() })
}
