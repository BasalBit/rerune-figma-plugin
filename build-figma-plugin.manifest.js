// RERUNE_DEV_MODE picks the release variant: "on" (default) keeps Dev Mode (inspect panel, Code section, Figma for
// VS Code); "off" builds the design-only plugin for releases whose Dev Mode parts were not tested on a paid Figma plan.
export function devModeOf(value) {
  const setting = value === undefined || value === "" ? "on" : value
  if (setting !== "on" && setting !== "off") {
    throw new Error(`RERUNE_DEV_MODE must be "on" or "off", got "${setting}"`)
  }
  return setting === "on"
}

export default function (manifest) {
  const dev = process.env.RERUNE_ENV === "development"
  const withRelaunch = {
    ...manifest,
    relaunchButtons: [{ command: "open", name: "Open ReRune", multipleSelection: true }],
  }
  if (!devModeOf(process.env.RERUNE_DEV_MODE)) {
    // Design-only: Figma Design is the only editor; id, network access and documentAccess stay as they are.
    const { capabilities, codegenLanguages, ...designOnly } = withRelaunch
    return { ...designOnly, editorType: ["figma"] }
  }
  return {
    ...withRelaunch,
    codegenLanguages: dev
      ? [...manifest.codegenLanguages, { label: "ReRune diagnostics", value: "rerune-diagnostics" }]
      : manifest.codegenLanguages,
  }
}
