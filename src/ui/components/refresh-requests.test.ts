import { h, type ComponentChildren, type VNode } from "preact"
import { describe, expect, it, vi } from "vitest"
import { emptyRefreshState, type RefreshRequest, type RefreshState } from "../state/refresh-requests"
import { emptyScreenshotRun } from "../state/screenshots"
import { RefreshRequestsNote, refreshNotesShown, type RefreshRequestsNoteProps } from "./refresh-requests"

// The Create Figma Plugin components bring their CSS, which the node environment cannot load: Button becomes a plain
// <button> here.
vi.mock("@create-figma-plugin/ui", () => ({
  Button: (props: { disabled?: boolean; onClick(): void; children: ComponentChildren }) => h("button", { disabled: props.disabled, onClick: props.onClick }, props.children),
  LoadingIndicator: () => null,
  Text: (props: { children: ComponentChildren }) => h("span", null, props.children),
}))

interface Rendered { type: string; props: Record<string, unknown>; children: (Rendered | string)[] }

// Expands function components (none of these use hooks) into a tree of elements and strings.
function render(node: unknown): (Rendered | string)[] {
  if (node === null || node === undefined || typeof node === "boolean") {
    return []
  }
  if (typeof node === "string" || typeof node === "number") {
    return [String(node)]
  }
  if (Array.isArray(node)) {
    return node.flatMap(render)
  }
  const vnode = node as VNode<Record<string, unknown>>
  if (typeof vnode.type === "function") {
    return render((vnode.type as (props: unknown) => unknown)(vnode.props))
  }
  return [{ type: String(vnode.type), props: vnode.props, children: render(vnode.props.children) }]
}

function text(nodes: (Rendered | string)[]): string {
  return nodes.map((node) => (typeof node === "string" ? node : text(node.children) + (node.type === "div" ? "\n" : ""))).join("")
}

function lines(nodes: (Rendered | string)[]): string[] {
  return text(nodes)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
}

function buttons(nodes: (Rendered | string)[]): { label: string; disabled: boolean; click(): void }[] {
  const found: { label: string; disabled: boolean; click(): void }[] = []
  const walk = (list: (Rendered | string)[]) => {
    for (const node of list) {
      if (typeof node === "string") {
        continue
      }
      if (node.type === "button") {
        found.push({ label: text(node.children).trim(), disabled: node.props.disabled === true, click: node.props.onClick as () => void })
      }
      walk(node.children)
    }
  }
  walk(nodes)
  return found
}

function request(n: number, frameId: string, overrides: Partial<RefreshRequest> = {}): RefreshRequest {
  return { screenshotId: "s" + n, frameId, frameName: "Frame " + n, pageName: "Mobile", requestedAt: "2026-10-29T10:00:00Z", requestedBy: "Ada Lovelace", ...overrides }
}

function props(state: Partial<RefreshState>, overrides: Partial<RefreshRequestsNoteProps> = {}): RefreshRequestsNoteProps {
  return {
    state: { ...emptyRefreshState(), ...state },
    busy: false,
    resetting: false,
    onRun: vi.fn(),
    onNotNow: vi.fn(),
    onStop: vi.fn(),
    onResetPreviews: vi.fn(),
    onRemove: vi.fn(),
    onRemoveAll: vi.fn(),
    onDismiss: vi.fn(),
    onSelect: vi.fn(),
    ...overrides,
  }
}

function view(input: RefreshRequestsNoteProps) {
  return render(h(RefreshRequestsNote, input))
}

describe("RefreshRequestsNote", () => {
  it("shows nothing without requests, results or a run", () => {
    expect(view(props({}))).toEqual([])
    expect(refreshNotesShown(emptyRefreshState())).toBe(false)
    const dismissed = { requests: [request(1, "10:1")], dismissed: new Set(["s1@2026-10-29T10:00:00Z"]) }
    expect(view(props(dismissed))).toEqual([])
    expect(refreshNotesShown({ ...emptyRefreshState(), ...dismissed })).toBe(false)
  })

  it("names the requests with Update screenshots and Not now, and waits while another task runs", () => {
    const input = props({ requests: [request(1, "10:1"), request(2, "11:1", { requestedBy: "Grace Hopper" })] })
    const nodes = view(input)
    expect(lines(nodes)).toEqual([
      "ReRune asks for new screenshots of 2 frames in this file.",
      "Requested by Ada Lovelace and Grace Hopper.",
      "Frame 1 (Mobile), Frame 2 (Mobile)",
      "Update screenshotsNot now",
    ])
    const [update, notNow] = buttons(nodes)
    expect([update.label, update.disabled, notNow.label]).toEqual(["Update screenshots", false, "Not now"])
    update.click()
    notNow.click()
    expect(input.onRun).toHaveBeenCalledTimes(1)
    expect(input.onNotNow).toHaveBeenCalledTimes(1)

    const busy = view(props({ requests: [request(1, "10:1")] }, { busy: true }))
    expect(buttons(busy)[0]).toMatchObject({ label: "Update screenshots", disabled: true })
    expect(lines(busy)).toContain("Wait for the current task to finish.")
  })

  it("shows the run's step, and the upload's progress with Stop", () => {
    expect(lines(view(props({ running: { step: "scanning" }, requests: [request(1, "10:1")] })))).toEqual(["Reading the requested frames…"])
    expect(lines(view(props({ running: { step: "updating" } })))).toEqual(["Updating layers from ReRune…"])
    const input = props({ running: { step: "uploading", run: { ...emptyScreenshotRun(3), done: 1 } } })
    const nodes = view(input)
    expect(lines(nodes)[0]).toBe("Uploading screenshots… 2 of 3")
    buttons(nodes)[0].click()
    expect(input.onStop).toHaveBeenCalled()
    expect(buttons(view(props({ running: { step: "uploading", run: emptyScreenshotRun(3) }, stopping: true })))[0]).toMatchObject({ label: "Stopping…", disabled: true })
  })

  it("lists the results in order with the missing and hidden frames' Remove request and Remove all", () => {
    const missing = [
      { screenshotId: "s2", frameId: "11:1", frameName: "Cart", pageName: "Mobile", hidden: false, removal: null, error: null },
      { screenshotId: "s3", frameId: "12:1", frameName: "Done", pageName: "", hidden: false, removal: "removed" as const, error: null },
      { screenshotId: "s4", frameId: "13:1", frameName: "Home", pageName: "Web", hidden: false, removal: null, error: "ReRune is busy. Wait a moment and try again." },
      { screenshotId: "s5", frameId: "15:1", frameName: "Legacy", pageName: "Web", hidden: true, removal: null, error: null },
    ]
    const run = { ...emptyScreenshotRun(2), done: 2, uploaded: 1, outdated: 1, problems: [{ frameId: "14:1", frameName: "Profile", message: "Figma couldn't export the frame." }] }
    const input = props({
      outcome: {
        kind: "done",
        pulled: 2,
        errors: [{ nodeId: "10:2", code: "missing_font", message: "A font in this layer is missing." }],
        figmaSide: 1,
        readonly: 0,
        shots: { kind: "done", run },
        missing,
      },
    })
    const nodes = view(input)
    expect(lines(nodes)).toEqual([
      "Updated 2 layers from ReRune.",
      "1 screenshot uploaded.",
      "1 layer changed in Figma or in both wasn't changed. Review it on Push.",
      "1 uploaded screenshot still shows text that differs from ReRune.",
      "3 requested frames aren't in this file anymore: Cart (Mobile), Done, Home (Web).",
      "1 requested frame is hidden in Figma, so its screenshot wasn't uploaded: Legacy (Web).",
      "Remove allDismiss",
      "Screenshots not uploaded (1)",
      "Figma couldn't export the frame.",
      "1 frame",
      "Profile",
      "Cart (Mobile)",
      "Remove request",
      "Done",
      "Request removed.",
      "Home (Web)",
      "Remove request",
      "ReRune is busy. Wait a moment and try again.",
      "Legacy (Web)",
      "Remove request",
      "1 layer: A font in this layer is missing.",
      "Select on canvas",
    ])
    const byLabel = buttons(nodes)
    byLabel.filter((button) => button.label === "Remove request")[1].click()
    expect(input.onRemove).toHaveBeenCalledWith("s4")
    byLabel.find((button) => button.label === "Remove all")?.click()
    expect(input.onRemoveAll).toHaveBeenCalled()
    byLabel.find((button) => button.label === "Dismiss")?.click()
    expect(input.onDismiss).toHaveBeenCalled()

    const removing = view(props({ outcome: input.state.outcome, removing: true }))
    expect(buttons(removing).filter((button) => button.label.startsWith("Remove")).every((button) => button.disabled)).toBe(true)
  })

  it("offers Reset previews for a run that stopped before writing, and says when nothing is requested anymore", () => {
    const input = props({ outcome: { kind: "previews", nodeIds: ["10:2", "10:3"] }, requests: [request(1, "10:1")] })
    const nodes = view(input)
    expect(lines(nodes)[0]).toBe("Reset previews in these frames first. 2 layers show a preview.")
    buttons(nodes)[0].click()
    expect(input.onResetPreviews).toHaveBeenCalledWith(["10:2", "10:3"])
    expect(lines(nodes)).toContain("ReRune asks for new screenshots of 1 frame in this file.")
    expect(buttons(view(props({ outcome: { kind: "previews", nodeIds: ["10:2"] } }, { resetting: true })))[0]).toMatchObject({ label: "Reset previews", disabled: true })
    expect(lines(view(props({ outcome: { kind: "none" } })))).toEqual(["ReRune no longer asks for new screenshots of this file.", "Dismiss"])
    expect(lines(view(props({ outcome: { kind: "error", message: "The scan didn't finish. Try again." } })))[0]).toBe("Screenshots weren't updated: The scan didn't finish. Try again.")
  })
})
