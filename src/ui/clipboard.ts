// Copy text from the plugin iframe (tooling map §2.9): navigator.clipboard is often missing there and
// execCommand("copy") can report success without copying, so a one-shot copy listener writes the data itself.
// The async Clipboard API is the last resort.

export interface ClipboardDocument {
  body: { appendChild(node: unknown): unknown }
  createElement(tag: "textarea"): HTMLTextAreaElement
  addEventListener(type: "copy", listener: (event: ClipboardEvent) => void): void
  removeEventListener(type: "copy", listener: (event: ClipboardEvent) => void): void
  execCommand(command: "copy"): boolean
}

export async function copyText(
  text: string,
  doc: ClipboardDocument = document,
  clipboard: Pick<Clipboard, "writeText"> | undefined = typeof navigator === "undefined" ? undefined : navigator.clipboard,
): Promise<boolean> {
  let copied = false
  const onCopy = (event: ClipboardEvent) => {
    if (event.clipboardData !== null) {
      event.clipboardData.setData("text/plain", text)
      event.preventDefault()
      copied = true
    }
  }
  const area = doc.createElement("textarea")
  area.value = text
  area.setAttribute("readonly", "")
  area.style.position = "fixed"
  area.style.top = "-1000px"
  area.style.opacity = "0"
  doc.body.appendChild(area)
  doc.addEventListener("copy", onCopy)
  try {
    area.select()
    doc.execCommand("copy")
  } catch {
    copied = false
  } finally {
    doc.removeEventListener("copy", onCopy)
    area.remove()
  }
  if (copied) {
    return true
  }
  if (clipboard === undefined) {
    return false
  }
  try {
    await clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
