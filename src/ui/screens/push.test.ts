/// <reference types="vite/client" />
import { h, type ComponentChildren, type VNode } from "preact"
import { describe, expect, it, vi } from "vitest"
import { scannedNode } from "../../../test/fixtures"
import { applyDecision, buildPushPlan, type PlanContext, type PlanCreate, type PlanDecision, type PushPlan } from "../../shared/push-plan"
import pushSource from "./push.tsx?raw"
import { Note } from "../components/ui"
import { CreateCard, MissingNote, NewTextHeader, resultSummary } from "./push"

// The New text header's Select all on the Push tab: ticked, partly ticked or not, one decision for every new text, and
// off, with every other choice in the plan, while Update layers from ReRune runs.

// The Create Figma Plugin components bring their CSS, which the node environment cannot load.
vi.mock("@create-figma-plugin/ui", () => ({
  Button: (props: { children: ComponentChildren; disabled?: boolean; loading?: boolean; onClick?: () => void }) =>
    h("button", { disabled: props.disabled, "data-loading": props.loading, onClick: props.onClick }, props.children),
  LoadingIndicator: () => null,
  SegmentedControl: () => null,
  Text: (props: { children: ComponentChildren }) => h("span", null, props.children),
  Textbox: (props: { value: string; disabled?: boolean }) => h("input", { type: "text", value: props.value, disabled: props.disabled }),
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
  return nodes.map((node) => (typeof node === "string" ? node : text(node.children))).join("")
}

function find(nodes: (Rendered | string)[], type: string): Rendered[] {
  return nodes.flatMap((node) => (typeof node === "string" ? [] : [...(node.type === type ? [node] : []), ...find(node.children, type)]))
}

// A page review of three new texts: each starts left out. "Pay now" exists in ReRune (Link to), the others are new keys.
function review(): { plan: PushPlan; context: PlanContext } {
  const nodes = [scannedNode("1:1", "Pay now"), scannedNode("1:2", "Cancel"), scannedNode("1:3", "Back")]
  const plan = buildPushPlan({
    projectId: "p",
    scope: "page",
    nodes,
    remote: new Map(),
    textMatches: new Map([["Pay now", [{ id: "k1", key: "pay_now" }]]]),
    groupIdenticalTexts: true,
    suggestName: (node) => "key_" + node.nodeId.slice(2),
  })
  const context: PlanContext = { projectId: "p", nodes: new Map(nodes.map((node) => [node.nodeId, node])), remote: new Map(), style: "snake", isTaken: () => false, suggestName: () => "" }
  return { plan, context }
}

function header(plan: PushPlan, disabled = false) {
  const onDecide = vi.fn<(decision: PlanDecision) => void>()
  const tree = render(h(NewTextHeader, { plan, disabled, onDecide }))
  const [box] = find(tree, "input")
  return { tree, box, onDecide, click: () => (box.props.onChange as () => void)() }
}

function card(create: PlanCreate, disabled = false) {
  const onDecide = vi.fn<(decision: PlanDecision) => void>()
  const tree = render(h(CreateCard, { create, taken: null, busy: false, disabled, onSelect: () => {}, onDecide, onRename: () => {}, onLinkExisting: () => {} }))
  const inputs = find(tree, "input")
  return {
    tree,
    onDecide,
    include: inputs.find((input) => input.props.type === "checkbox"),
    name: inputs.find((input) => input.props.type === "text"),
    choices: find(tree, "button").filter((button) => ["Create new key", "Link to pay_now"].includes(text(button.children))),
  }
}

// The PushScreen function itself, without the components after it.
function screenSource(): string {
  const start = pushSource.indexOf("export function PushScreen(")
  return pushSource.slice(start, pushSource.indexOf("\n}\n", start))
}

describe("Push: Select all new texts", () => {
  it("sits in the New text header with its count, and includes every new text from none", () => {
    const { plan } = review()
    const shown = header(plan)
    expect(text(shown.tree)).toBe("New text (3)Select all")
    expect(shown.box.props).toMatchObject({ type: "checkbox", checked: false, indeterminate: false, disabled: false, "aria-label": "Select all new texts (3)" })
    expect(find(shown.tree, "label")).toHaveLength(1)
    shown.click()
    expect(shown.onDecide).toHaveBeenCalledWith({ kind: "creates-selected", selected: true })
  })

  it("is the ReRune section title (mono caps after the amber bar) with the plain checkbox and its focus ring", () => {
    const shown = header(review().plan)
    const [title] = find(shown.tree, "div").filter((node) => node.props.class === "rr-eyebrow")
    expect(title.props).toMatchObject({ role: "heading", "aria-level": 2 })
    expect(text(title.children)).toBe("New text (3)")
    expect(shown.box.props.class).toBe("rr-check rr-focus")
  })

  it("is partly ticked when only some are included, and ticking it includes them all", () => {
    const { plan, context } = review()
    const some = header(applyDecision(plan, { kind: "create-selected", ref: "c1", selected: true }, context))
    expect(some.box.props).toMatchObject({ checked: false, indeterminate: true })
    some.click()
    expect(some.onDecide).toHaveBeenCalledWith({ kind: "creates-selected", selected: true })
  })

  it("is ticked when every new text is included, and unticking it leaves them all out", () => {
    const { plan, context } = review()
    const all = header(applyDecision(plan, { kind: "creates-selected", selected: true }, context))
    expect(all.box.props).toMatchObject({ checked: true, indeterminate: false })
    all.click()
    expect(all.onDecide).toHaveBeenCalledWith({ kind: "creates-selected", selected: false })
    const none = applyDecision(applyDecision(plan, { kind: "creates-selected", selected: true }, context), { kind: "creates-selected", selected: false }, context)
    expect(header(none).box.props).toMatchObject({ checked: false, indeterminate: false })
  })

  it("waits, with every choice on each card, while Update layers from ReRune runs", () => {
    const { plan } = review()
    expect(header(plan, true).box.props).toMatchObject({ disabled: true, style: { cursor: "default" } })
    const [linked, created] = plan.creates
    // Pay now: Include in push and Link to / Create new key; Cancel: Include in push and its name.
    for (const disabled of [false, true]) {
      const link = card(linked, disabled)
      expect(link.include?.props).toMatchObject({ "aria-label": "Include in push", disabled })
      expect(link.choices.map((choice) => [text(choice.children), choice.props.disabled])).toEqual([["Link to pay_now", disabled], ["Create new key", disabled]])
      const create = card(created, disabled)
      expect(create.include?.props).toMatchObject({ "aria-label": "Include in push", disabled })
      expect(create.name?.props).toMatchObject({ value: "key_2", disabled })
    }
    const enabled = card(linked)
    ;(enabled.include?.props.onChange as () => void)()
    expect(enabled.onDecide).toHaveBeenCalledWith({ kind: "create-selected", ref: linked.ref, selected: true })
  })

  it("locks the plan's choices only while Update layers from ReRune runs, on the header, the cards and every other section", () => {
    const screen = screenSource()
    expect(screen).toMatch(/const choicesDisabled = pulling\n/)
    expect(screen).toContain("<NewTextHeader plan={plan} disabled={choicesDisabled} onDecide={decide} />")
    expect(screen).toMatch(/<CreateCard\s[^>]*?disabled=\{choicesDisabled\}/)
    const choices = screen.match(/<Choice\b[\s\S]*?\/>/g) ?? []
    expect(choices.length).toBeGreaterThan(0)
    for (const choice of choices) {
      expect(choice).toContain("disabled={choicesDisabled}")
    }
  })

  it("is a choice like any other (the screen's decide), and the quota warning follows the counts at once", () => {
    const decide = pushSource.slice(pushSource.indexOf("function decide(decision: PlanDecision) {"), pushSource.indexOf("function rename("))
    expect(decide).toContain("setTouched(true)")
    expect(decide).toContain("applyDecision(prepared.plan, decision, prepared.context)")
    expect(pushSource).toContain("{available !== null && overQuota(counts, available) && (")
    expect(pushSource).toContain("const counts = plan === null ? null : pushCounts(plan)")
  })
})

// The results' summary after a push with a key edited in ReRune meanwhile: the note turns good with the postmark once the
// last conflict is resolved, and the postmark's room is there from the start, so nothing moves when it stamps in.
describe("Push results: the summary's postmark", () => {
  const conflicts = [{ ref: "a" }, { ref: "b" }]
  const failure = { ref: "f" }

  it("keeps the postmark's room while conflicts are open, and stamps it in once none is left open", () => {
    expect(resultSummary({ failures: [], conflicts: [] }, {})).toEqual({ tone: "good", postmark: true })
    expect(resultSummary({ failures: [], conflicts }, {})).toEqual({ tone: "info", postmark: "room" })
    // A choice still running (Overwrite, Take ReRune text) leaves its conflict open.
    expect(resultSummary({ failures: [], conflicts }, { a: { done: true }, b: { done: false } })).toEqual({ tone: "info", postmark: "room" })
    expect(resultSummary({ failures: [], conflicts }, { a: { done: true }, b: { done: true } })).toEqual({ tone: "good", postmark: true })
  })

  it("has no postmark and no room when something failed, since the run can't turn clean", () => {
    expect(resultSummary({ failures: [failure], conflicts: [] }, {})).toEqual({ tone: "info", postmark: false })
    expect(resultSummary({ failures: [failure], conflicts }, { a: { done: true }, b: { done: true } })).toEqual({ tone: "info", postmark: false })
  })

  it("is the same note box with the room, the postmark drawn only when the run is clean", () => {
    const note = (postmark: boolean | "room") => render(h(Note, { tone: postmark === true ? "good" : "info", postmark, children: "Nothing was changed." }))
    const box = (postmark: boolean | "room") => find(note(postmark), "div")[0].props.class
    expect(box("room")).toBe("rr-note rr-tone--info rr-tinted rr-postmarked")
    expect(box(true)).toBe("rr-note rr-tone--good rr-tinted rr-postmarked")
    expect(box(false)).toBe("rr-note rr-tone--info rr-tinted")
    expect(find(note("room"), "svg")).toHaveLength(0)
    expect(find(note(false), "svg")).toHaveLength(0)
    expect(find(note(true), "svg").filter((svg) => svg.props.class === "rr-postmark")).toHaveLength(1)
  })

  it("is what the results show", () => {
    const results = pushSource.slice(pushSource.indexOf("function Results("), pushSource.indexOf("{linkSyncWarning(run.linkSync)"))
    expect(results).toContain("const summary = resultSummary(run, props.resolved)")
    expect(results).toContain("<Note tone={summary.tone} postmark={summary.postmark}>")
  })
})

describe("Push: frames with linked keys but no screenshot in ReRune yet", () => {
  function note(props: { count: number; pushable: boolean; disabled?: boolean; loading?: boolean }) {
    const onUpload = vi.fn()
    const tree = render(h(MissingNote, { disabled: false, loading: false, ...props, onUpload }))
    return { tree, onUpload, buttons: find(tree, "button") }
  }

  it("counts them before anything starts, with Upload screenshots when there is nothing else to push", () => {
    const shown = note({ count: 3, pushable: false })
    expect(text(shown.tree)).toBe("3 frames with linked keys have no screenshot in ReRune yet.Upload screenshots")
    expect(shown.buttons).toHaveLength(1)
    expect(shown.buttons[0].props).toMatchObject({ disabled: false, "data-loading": false })
    ;(shown.buttons[0].props.onClick as () => void)()
    expect(shown.onUpload).toHaveBeenCalledTimes(1)
    expect(text(note({ count: 1, pushable: false }).tree)).toBe("1 frame with linked keys has no screenshot in ReRune yet.Upload screenshots")
  })

  it("says the push uploads them when there is something to push, without a button of its own", () => {
    const shown = note({ count: 2, pushable: true })
    expect(text(shown.tree)).toBe("2 frames with linked keys have no screenshot in ReRune yet. Push uploads them too.")
    expect(shown.buttons).toHaveLength(0)
  })

  it("waits while a task runs or a layer shows a preview, and shows the run starting", () => {
    expect(note({ count: 2, pushable: false, disabled: true }).buttons[0].props.disabled).toBe(true)
    expect(note({ count: 2, pushable: false, loading: true }).buttons[0].props["data-loading"]).toBe(true)
    const screen = screenSource()
    expect(screen).toContain("{missing.length > 0 && (")
    expect(screen).toContain("disabled={busy || plan.blockedByPreview.length > 0}")
    expect(screen).toContain("loading={sending}")
    expect(screen).toContain("onUpload={() => void uploadMissing()}")
    // The note sits under the plan's summary ("Everything in scope matches ReRune. Nothing to push.") and hides while an
    // upload runs (noteFrames, tested in missing-screenshots.test.ts); the run's check, progress with Stop, and its
    // result show under it, and why Upload screenshots uploaded nothing.
    expect(screen.indexOf("<Summary plan={plan} />")).toBeLessThan(screen.indexOf("<MissingNote"))
    expect(screen).toContain("const missing = useMemo(() => (prepared === null ? [] : shotsCtl.noteFrames(prepared, submittable)), [prepared, stored, shots, submittable])")
    expect(screen).toContain("{pulled === null && shots !== null && <ScreenshotStatus state={shots} stopping={stopping} onStop={stopScreenshots} onSelect={props.onSelect} />}")
    expect(screen).toContain("{uploadNote !== null && <Note tone={uploadNote.tone}>{uploadNote.text}</Note>}")
  })
})
