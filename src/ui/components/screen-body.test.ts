/// <reference types="vite/client" />
import { h, type ComponentChildren, type JSX, type VNode } from "preact"
import { describe, expect, it } from "vitest"
import { normalizeSources } from "../../../test/source-graph"
import { NOTICES_GAP, ScreenBody } from "./screen-body"
import { styles } from "./styles"

// The workspace notices (file link: copy, branch, no link, no Edit keys; the settings offer; layers edited during
// preview; leftover previews; the result banner) sit at the top of the open tab's scroll area, in normal flow. On a
// band between the tab bar and the tab they did not scroll, so the tab's content scrolled out of sight right under
// them: on Preview the Language label was hidden and the dropdown looked tucked under the file-link notice.

type Props = { style?: JSX.CSSProperties; children?: ComponentChildren }

function body(notices: ComponentChildren, stack?: boolean): VNode<Props> {
  return ScreenBody({ notices, stack, children: h("div", { id: "content" }, "Language") }) as VNode<Props>
}

function children(vnode: VNode<Props>): VNode<Props>[] {
  return ([] as unknown[]).concat(vnode.props.children).filter((child): child is VNode<Props> => typeof child === "object" && child !== null)
}

// What could take the notices out of normal flow or draw them over the content.
const OUT_OF_FLOW = ["position", "top", "bottom", "inset", "transform", "zIndex", "marginTop", "float"]

describe("ScreenBody (the scroll area of a workspace tab)", () => {
  const notices = h("div", { id: "notices" }, "Paste this file's Figma link")

  it("is the tab's scroll container", () => {
    const style = body(notices, true).props.style ?? {}
    expect(style).toMatchObject({ overflowY: "auto", flex: "1", minHeight: "0" })
  })

  it.each([true, false])("puts the notices first, in normal flow, in the same scroll container as the content (stack: %s)", (stack) => {
    const [slot, content] = children(body(notices, stack))
    expect(slot.props.children).toBe(notices)
    expect(content.props).toMatchObject({ id: "content" })
    const style = (slot.props.style ?? {}) as Record<string, unknown>
    for (const property of OUT_OF_FLOW) {
      expect(style[property], property).toBeUndefined()
    }
    // The slot keeps its height in the flex column of a stacked body instead of shrinking under the content.
    expect(style.flexShrink).toBe("0")
  })

  it("spaces the notices from the content like the rest of the tab", () => {
    const [stacked] = children(body(notices, true))
    expect(stacked.props.style?.marginBottom).toBeUndefined()
    expect(body(notices, true).props.style?.gap).toBe(styles.stack.gap)
    const [plain] = children(body(notices, false))
    expect(plain.props.style?.marginBottom).toBe(NOTICES_GAP)
    expect(NOTICES_GAP).toBe(styles.stack.gap)
  })

  it.each([null, undefined, false, []])("renders only the content without notices (%j)", (none) => {
    const parts = children(body(none as ComponentChildren))
    expect(parts).toHaveLength(1)
    expect(parts[0].props).toMatchObject({ id: "content" })
  })
})

const sources = normalizeSources(import.meta.glob<string>(["../app.tsx", "../screens/*.tsx"], { query: "?raw", import: "default", eager: true }))
const app = sources["../app.tsx"]
const SCREENS = { layers: "LayersScreen", push: "PushScreen", preview: "PreviewScreen", qa: "QaScreen", settings: "SettingsScreen" } as const

function count(text: string, part: string): number {
  return text.split(part).length - 1
}

describe("workspace notices in the app", () => {
  it.each(Object.keys(SCREENS))("%s: every scroll area of the tab is a ScreenBody with the notices", (screen) => {
    const source = sources["../screens/" + screen + ".tsx"]
    expect(source).toBeDefined()
    const pages = count(source, "<div style={styles.page}>")
    expect(pages).toBeGreaterThan(0)
    expect(count(source, "<ScreenBody notices={props.notices}")).toBe(pages)
    expect(source).not.toContain("styles.body")
  })

  it("hands the notices to every workspace tab", () => {
    for (const component of Object.values(SCREENS)) {
      expect(app, component).toMatch(new RegExp("<" + component + "\\n\\s+notices=\\{notices\\}"))
    }
  })

  it("renders the notices only inside the element it hands to the tabs, not between the tab bar and the tab", () => {
    const start = app.indexOf("  const notices =")
    const end = app.indexOf("\n  return (", start)
    expect(start).toBeGreaterThan(-1)
    const inside = app.slice(start, end)
    for (const part of ["<SettingsOfferNote", "<FileLinkNote", "edited during preview", "{leftover}", "{banner.message}", "<ErrorGroups groups={banner.errors}"]) {
      expect(inside, part).toContain(part)
      expect(count(app, part), part).toBe(1)
    }
    // In the workspace page the tab bar is followed directly by the tab's container.
    expect(app.slice(end)).toMatch(/\n {6}\/>\n {6}<div style=\{\{ flex: "1", minHeight: "0", display: "flex", flexDirection: "column" \}\}>\n {8}\{screen === "layers"/)
  })
})
