export default function (manifest) {
  const dev = process.env.RERUNE_ENV === "development"
  return {
    ...manifest,
    relaunchButtons: [{ command: "open", name: "Open ReRune", multipleSelection: true }],
    codegenLanguages: dev
      ? [...manifest.codegenLanguages, { label: "ReRune diagnostics", value: "rerune-diagnostics" }]
      : manifest.codegenLanguages,
  }
}
