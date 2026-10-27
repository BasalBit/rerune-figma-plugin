import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  fakeComponent,
  fakeComponentSet,
  fakeFrame,
  fakeGroup,
  fakeInstance,
  fakeSection,
  fakeText,
  installFigma,
  onPage,
  uninstallFigma,
  type FakeNode,
  type FigmaMock,
} from "../../test/figma-mock"
import { DATA_KEYS, PLUGIN_DATA_NAMESPACE } from "../shared/constants"
import { serializeLangCopy } from "../shared/plugin-data"
import {
  ancestorsOf,
  collectTextNodes,
  componentNameOf,
  createNodeCaches,
  isBoundToComponentProperty,
  isBoundToVariable,
  isHidden,
  isInLanguageCopy,
  isInRemoteComponent,
  isLocked,
  overrideFlags,
  pageOf,
  parentNamesOf,
  readOverrides,
  topFrameOf,
  withInvisibleInstanceChildren,
} from "./node-utils"

let figmaMock: FigmaMock

beforeEach(() => {
  figmaMock = installFigma()
})

afterEach(() => {
  uninstallFigma()
})

function base(node: FakeNode): BaseNode {
  return node as unknown as BaseNode
}

function text(node: FakeNode): TextNode {
  return node as unknown as TextNode
}

describe("tree helpers", () => {
  it("finds the page and the ancestors up to it", () => {
    const label = fakeText("1:3", "Pay")
    const group = fakeGroup("1:2", "Footer", [label])
    const frame = fakeFrame("1:1", "Checkout", [group])
    onPage(figmaMock, [frame])
    expect(pageOf(base(label))?.id).toBe("0:1")
    expect(ancestorsOf(base(label)).map((node) => node.id)).toEqual(["1:2", "1:1"])
  })

  it("topFrameOf walks to the node below the page or section", () => {
    const deep = fakeText("1:3", "Pay")
    const inner = fakeFrame("1:2", "Card", [deep])
    const top = fakeFrame("1:1", "Checkout", [inner])
    const inSection = fakeText("2:2", "Hello")
    const sectionFrame = fakeFrame("2:1", "Welcome", [inSection])
    const section = fakeSection("2:0", "Flow", [sectionFrame])
    const loose = fakeText("3:1", "Loose")
    const groupText = fakeText("4:2", "In group")
    const group = fakeGroup("4:1", "Group", [groupText])
    onPage(figmaMock, [top, section, loose, group])
    expect(topFrameOf(base(deep))?.id).toBe("1:1")
    expect(topFrameOf(base(inSection))?.id).toBe("2:1")
    expect(topFrameOf(base(loose))).toBeNull()
    expect(topFrameOf(base(groupText))).toBeNull()
  })

  it("accepts components, component sets and instances as top frames", () => {
    const a = fakeText("1:2", "A")
    const b = fakeText("2:3", "B")
    const c = fakeText("I3:1;9:9", "C")
    onPage(figmaMock, [fakeComponent("1:1", "Button", [a]), fakeComponentSet("2:1", "Chip", [fakeComponent("2:2", "State=On", [b])]), fakeInstance("3:1", "Button", [c])])
    expect(topFrameOf(base(a))?.type).toBe("COMPONENT")
    expect(topFrameOf(base(b))?.type).toBe("COMPONENT_SET")
    expect(topFrameOf(base(c))?.type).toBe("INSTANCE")
  })

  it("lists parent names nearest first, at most 5, without sections", () => {
    let node: FakeNode = fakeText("9:9", "Leaf")
    const leaf = node
    for (let i = 1; i <= 6; i++) {
      node = fakeFrame("9:" + i, "Level " + i, [node])
    }
    onPage(figmaMock, [fakeSection("9:0", "Section", [node])])
    expect(parentNamesOf(base(leaf))).toEqual(["Level 1", "Level 2", "Level 3", "Level 4", "Level 5"])
  })

  it("detects nodes inside library components", () => {
    const local = fakeText("1:2", "A")
    const remote = fakeText("2:2", "B")
    onPage(figmaMock, [fakeComponent("1:1", "Local", [local]), fakeComponent("2:1", "Library", [remote], { remote: true })])
    expect(isInRemoteComponent(base(local))).toBe(false)
    expect(isInRemoteComponent(base(remote))).toBe(true)
  })
})

describe("overrideFlags (D44 inputs)", () => {
  it("is false for nodes that are not instance sublayers", () => {
    const node = fakeText("5:67", "x")
    expect(overrideFlags(base(node), createNodeCaches())).toEqual({ ownPluginDataOverride: false, textOverridden: false })
  })

  it("reads pluginData and characters overrides from instance ancestors", () => {
    const sub = fakeText("I12:34;5:67", "x")
    const other = fakeText("I12:34;5:68", "y")
    fakeInstance("12:34", "Button", [sub, other], {
      overrides: [
        { id: "I12:34;5:67", overriddenFields: ["pluginData", "characters"] },
        { id: "I12:34;5:99", overriddenFields: ["pluginData"] },
      ],
    })
    expect(overrideFlags(base(sub), createNodeCaches())).toEqual({ ownPluginDataOverride: true, textOverridden: true })
    expect(overrideFlags(base(other), createNodeCaches())).toEqual({ ownPluginDataOverride: false, textOverridden: false })
  })

  it("walks every instance ancestor of a nested instance", () => {
    const sub = fakeText("I1:2;3:4;5:6", "x")
    const inner = fakeInstance("I1:2;3:4", "Icon", [sub], { overrides: [] })
    fakeInstance("1:2", "Card", [inner], { overrides: [{ id: "I1:2;3:4;5:6", overriddenFields: ["characters"] }] })
    expect(overrideFlags(base(sub), createNodeCaches())).toEqual({ ownPluginDataOverride: false, textOverridden: true })
  })

  it("returns null for pluginData when overrides cannot be read, and caches per instance", () => {
    let reads = 0
    const sub = fakeText("I12:34;5:67", "x")
    const instance = fakeInstance("12:34", "Button", [sub], {
      overrides: () => {
        reads++
        throw new Error("not readable")
      },
    })
    const caches = createNodeCaches()
    expect(overrideFlags(base(sub), caches)).toEqual({ ownPluginDataOverride: null, textOverridden: false })
    expect(overrideFlags(base(sub), caches)).toEqual({ ownPluginDataOverride: null, textOverridden: false })
    expect(readOverrides(instance as unknown as InstanceNode, caches)).toBeNull()
    expect(reads).toBe(1)
  })

  it("still reports a pluginData override found on a readable ancestor", () => {
    const sub = fakeText("I1:2;3:4;5:6", "x")
    const inner = fakeInstance("I1:2;3:4", "Icon", [sub], { overrides: [{ id: "I1:2;3:4;5:6", overriddenFields: ["pluginData"] }] })
    fakeInstance("1:2", "Card", [inner], {
      overrides: () => {
        throw new Error("x")
      },
    })
    expect(overrideFlags(base(sub), createNodeCaches()).ownPluginDataOverride).toBe(true)
  })
})

describe("visibility, lock and language-copy filters", () => {
  it("memoises hidden ancestors", () => {
    const a = fakeText("1:3", "A")
    const b = fakeText("1:4", "B")
    const group = fakeGroup("1:2", "Hidden group", [a, b])
    group.visible = false
    const visible = fakeText("1:5", "C")
    onPage(figmaMock, [fakeFrame("1:1", "Frame", [group, visible])])
    const caches = createNodeCaches()
    expect(isHidden(base(a), caches)).toBe(true)
    expect(caches.hidden.get("1:2")).toBe(true)
    expect(isHidden(base(b), caches)).toBe(true)
    expect(isHidden(base(visible), caches)).toBe(false)
    expect(caches.hidden.get("1:1")).toBe(false)
  })

  it("treats a hidden node itself as hidden", () => {
    const node = fakeText("1:2", "A", { visible: false })
    onPage(figmaMock, [fakeFrame("1:1", "Frame", [node])])
    expect(isHidden(base(node), createNodeCaches())).toBe(true)
  })

  it("detects locked nodes and locked ancestors", () => {
    const a = fakeText("1:3", "A")
    const frame = fakeFrame("1:1", "Frame", [fakeFrame("1:2", "Locked", [a], { locked: true })])
    const b = fakeText("2:1", "B", { locked: true })
    onPage(figmaMock, [frame, b])
    expect(isLocked(base(a), createNodeCaches())).toBe(true)
    expect(isLocked(base(b), createNodeCaches())).toBe(true)
  })

  it("skips text in language copies only when the marker's nid is the frame's own id", () => {
    const marker = (nid: string) => serializeLangCopy({ v: 1, nid, lang: "de", source: "draft", variationOptionId: null, sourceFrameId: "10:1", createdAt: 1 })
    const inCopy = fakeText("11:2", "Hallo")
    const copy = fakeFrame("11:1", "Checkout — de", [inCopy])
    copy.setSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.langCopy, marker("11:1"))
    const inDuplicate = fakeText("12:2", "Hallo")
    const duplicate = fakeFrame("12:1", "Checkout — de copy", [inDuplicate])
    duplicate.setSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.langCopy, marker("11:1"))
    onPage(figmaMock, [copy, duplicate])
    const caches = createNodeCaches()
    expect(isInLanguageCopy(base(inCopy), caches)).toBe(true)
    expect(isInLanguageCopy(base(inDuplicate), caches)).toBe(false)
  })
})

describe("componentNameOf", () => {
  it("uses the component set name for an instance of a variant (cached per instance)", async () => {
    const variant = fakeComponent("2:2", "State=Default")
    fakeComponentSet("2:1", "Button", [variant])
    const a = fakeText("I3:1;2:5", "Pay")
    const b = fakeText("I3:1;2:6", "Now")
    const instance = fakeInstance("3:1", "Button", [a, b], { mainComponent: variant })
    onPage(figmaMock, [fakeFrame("1:1", "Checkout", [instance])])
    const caches = createNodeCaches()
    expect(await componentNameOf(base(a), caches)).toBe("Button")
    expect(await componentNameOf(base(b), caches)).toBe("Button")
    expect(instance.getMainComponentAsync).toHaveBeenCalledTimes(1)
  })

  it("uses the main component name, the enclosing component, or null", async () => {
    const main = fakeComponent("2:1", "Badge")
    const inInstance = fakeText("I3:1;2:2", "New")
    fakeInstance("3:1", "Badge", [inInstance], { mainComponent: main })
    const inComponent = fakeText("4:2", "Label")
    fakeComponent("4:1", "Tag", [inComponent])
    const inVariant = fakeText("5:3", "On")
    fakeComponentSet("5:1", "Toggle", [fakeComponent("5:2", "State=On", [inVariant])])
    const plain = fakeText("6:2", "Plain")
    onPage(figmaMock, [fakeFrame("6:1", "Frame", [plain])])
    expect(await componentNameOf(base(inInstance), createNodeCaches())).toBe("Badge")
    expect(await componentNameOf(base(inComponent), createNodeCaches())).toBe("Tag")
    expect(await componentNameOf(base(inVariant), createNodeCaches())).toBe("Toggle")
    expect(await componentNameOf(base(plain), createNodeCaches())).toBeNull()
  })

  it("returns null when the main component cannot be read", async () => {
    const sub = fakeText("I3:1;2:2", "x")
    const instance = fakeInstance("3:1", "Badge", [sub])
    instance.getMainComponentAsync.mockRejectedValue(new Error("gone"))
    expect(await componentNameOf(base(sub), createNodeCaches())).toBeNull()
  })
})

describe("bindings", () => {
  it("detects text bound to a variable or a component property", () => {
    const plain = fakeText("1:1", "x")
    const variable = fakeText("1:2", "x", { boundVariables: { characters: { type: "VARIABLE_ALIAS", id: "VariableID:1" } } })
    const property = fakeText("1:3", "x", { componentPropertyReferences: { characters: "Label#1:2" } })
    expect(isBoundToVariable(text(plain))).toBe(false)
    expect(isBoundToVariable(text(variable))).toBe(true)
    expect(isBoundToComponentProperty(text(plain))).toBe(false)
    expect(isBoundToComponentProperty(text(property))).toBe(true)
  })
})

describe("collectTextNodes", () => {
  it("collects root text and text under each child, without duplicates", async () => {
    const children = Array.from({ length: 25 }, (_, i) => fakeFrame("2:" + i, "Row " + i, [fakeText("3:" + i, "Text " + i)]))
    const frame = fakeFrame("1:1", "List", children)
    const root = fakeText("4:1", "Root text")
    onPage(figmaMock, [frame, root])
    const nodes = await collectTextNodes([base(frame), base(root), base(children[0])])
    expect(nodes?.map((node) => node.id)).toEqual([...children.map((_, i) => "3:" + i), "4:1"])
  })

  it("stops when the work becomes stale", async () => {
    const frame = fakeFrame("1:1", "List", Array.from({ length: 25 }, (_, i) => fakeText("2:" + i, "x")))
    onPage(figmaMock, [frame])
    expect(await collectTextNodes([base(frame)], () => true)).toBeNull()
  })

  it("yields every 25 roots, also when each root has few children", async () => {
    const roots = Array.from({ length: 60 }, (_, i) => fakeFrame("2:" + i, "Card " + i, [fakeText("3:" + i, "Text " + i)]))
    onPage(figmaMock, roots)
    let checks = 0
    const nodes = await collectTextNodes(roots.map(base), () => {
      checks++
      return false
    })
    expect(nodes).toHaveLength(60)
    expect(checks).toBe(2)
    expect(await collectTextNodes(roots.map(base), () => true)).toBeNull()
  })
})

describe("withInvisibleInstanceChildren", () => {
  it("turns the flag off and restores the outermost value when overlapping runs end", async () => {
    figmaMock.skipInvisibleInstanceChildren = true
    let release: () => void = () => {}
    const first = withInvisibleInstanceChildren(() => new Promise<void>((resolve) => (release = resolve)))
    const second = withInvisibleInstanceChildren(async () => {
      expect(figmaMock.skipInvisibleInstanceChildren).toBe(false)
    })
    await second
    expect(figmaMock.skipInvisibleInstanceChildren).toBe(false)
    release()
    await first
    expect(figmaMock.skipInvisibleInstanceChildren).toBe(true)
  })

  it("restores the flag when the work throws", async () => {
    figmaMock.skipInvisibleInstanceChildren = true
    await expect(withInvisibleInstanceChildren(async () => {
      throw new Error("boom")
    })).rejects.toThrow("boom")
    expect(figmaMock.skipInvisibleInstanceChildren).toBe(true)
  })
})
