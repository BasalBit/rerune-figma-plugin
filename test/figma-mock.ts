import { vi, type Mock } from "vitest"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test doubles stand in for many Figma signatures
export type MockFn = Mock<(...args: any[]) => any>

// A small in-memory model of the Figma Plugin API, big enough for main-thread tests (tooling map §1.9).
// Nodes are plain objects; tests pass them to main code directly or fetch them through figma.getNodeByIdAsync.

export interface FakeFont { family: string; style: string }

export interface FakeStyle {
  fontName: FakeFont
  fontSize: number
  fills: unknown[]
  textDecoration: string
  textCase: string
  letterSpacing: unknown
  lineHeight: unknown
  textStyleId: string
  fillStyleId: string
  boundVariables: Record<string, unknown>
  hyperlink: unknown
  listOptions: unknown
  indentation: number
  paragraphSpacing: number
}

export type FakeOverride = { id: string; overriddenFields: string[] }

export interface FakeNode {
  id: string
  type: string
  name: string
  parent: FakeNode | null
  removed: boolean
  visible: boolean
  locked: boolean
  readonly children: FakeNode[]
  allChildren: FakeNode[]
  inheritFrom: FakeNode | null
  getSharedPluginData(namespace: string, key: string): string
  setSharedPluginData(namespace: string, key: string, value: string): void
  getSharedPluginDataKeys(namespace: string): string[]
  setRelaunchData: MockFn
  getRelaunchData(): Record<string, string>
  findAllWithCriteria(criteria: { types?: string[]; sharedPluginData?: { namespace: string; keys?: string[] } }): FakeNode[]
  findAll(callback?: (node: FakeNode) => boolean): FakeNode[]
  appendChild(child: FakeNode): void
  insertChild(index: number, child: FakeNode): void
  clone(): FakeNode
  remove(): void
  [key: string]: unknown
}

export interface FakeText extends FakeNode {
  characters: string
  styles: FakeStyle[]
  autoRename: boolean
  hasMissingFont: boolean
  readonly fontName: FakeFont | symbol
  componentPropertyReferences: Record<string, string> | null
  boundVariables: Record<string, unknown>
  getRangeAllFontNames(start: number, end: number): FakeFont[]
  getStyledTextSegments(fields: string[], start?: number, end?: number): Record<string, unknown>[]
  setRangeFontName: MockFn
  setRangeFontSize: MockFn
  setRangeTextDecoration: MockFn
  setRangeTextCase: MockFn
  setRangeLetterSpacing: MockFn
  setRangeLineHeight: MockFn
  setRangeFills: MockFn
  setRangeTextStyleIdAsync: MockFn
  setRangeFillStyleIdAsync: MockFn
  setRangeBoundVariable: MockFn
  setRangeHyperlink: MockFn
  setRangeListOptions: MockFn
  setRangeIndentation: MockFn
  setRangeParagraphSpacing: MockFn
}

export interface FakeInstance extends FakeNode {
  overrides: FakeOverride[]
  mainComponent: FakeNode | null
  getMainComponentAsync: MockFn
}

const registry = new Map<string, FakeNode>()
let cloneCounter = 0

function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T)
}
let current: FigmaMock | null = null

// Figma hands out read-only values: arrays and objects that the API returns (properties such as fills, children,
// selection, overrides or boundVariables, and method results such as getRangeAllFontNames or
// getStyledTextSegments) are frozen, so changing one in place throws ("object is not extensible", "Cannot assign
// to read only property"; developers.figma.com/docs/plugins/editing-properties). The mock hands out frozen copies
// and keeps its own state mutable. Nodes inside a value (children, selection) stay the live nodes; only the list is
// frozen. Results Figma does not document as frozen (findAll, plugin data keys, relaunch data, clientStorage) are
// frozen too: getRangeAllFontNames is typed as a plain array and is frozen in Figma, so code must never count on
// changing what it read.
const liveNodes = new WeakSet<object>()

function handOut<T>(value: T): T {
  if (typeof value !== "object" || value === null || liveNodes.has(value) || ArrayBuffer.isView(value)) {
    return value
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map(handOut)) as T
  }
  const copy: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    copy[key] = handOut(entry)
  }
  return Object.freeze(copy) as T
}

function frozenList<T>(value: T): T {
  return Array.isArray(value) ? (Object.freeze(value.slice()) as T) : value
}

// Node properties whose value Figma hands out frozen (object or array valued). Tests set them through the node's
// extras or by assignment; reads get a frozen copy.
const FROZEN_DATA_KEYS = new Set([
  "fills", "strokes", "effects", "layoutGrids", "exportSettings", "constraints", "absoluteBoundingBox",
  "absoluteRenderBounds", "absoluteTransform", "relativeTransform", "boundVariables", "componentPropertyReferences",
  "componentProperties", "componentPropertyDefinitions", "variantProperties", "overrides", "guides",
])
// Node lists: the list is frozen, its nodes are not.
const FROZEN_LIST_KEYS = new Set(["selection", "exposedInstances"])
// Getters the mock defines for those keys; clone() reads their value instead of skipping them like a test's getter.
const handOutGetters = new WeakSet<() => unknown>()

// Defines `key` on a fake node: a frozen hand-out accessor for the keys above (assigning stores the value the next
// read hands out; a function value is called on every read, as for overrides that change or cannot be read), a
// plain data property otherwise.
function defineValue(node: object, key: string, value: unknown): void {
  if (!FROZEN_DATA_KEYS.has(key) && !FROZEN_LIST_KEYS.has(key)) {
    Object.defineProperty(node, key, { value, writable: true, configurable: true, enumerable: true })
    return
  }
  let stored = value
  const get = FROZEN_LIST_KEYS.has(key) ? () => frozenList(stored) : () => handOut(typeof stored === "function" ? (stored as () => unknown)() : stored)
  handOutGetters.add(get)
  Object.defineProperty(node, key, {
    get,
    set: (next: unknown) => {
      stored = next
    },
    configurable: true,
    enumerable: true,
  })
  Object.defineProperty(node, "__stored_" + key, { value: () => stored, configurable: true, enumerable: false })
}

function fontId(font: FakeFont): string {
  return font.family + "\u0000" + font.style
}

export function defaultStyle(overrides: Partial<FakeStyle> = {}): FakeStyle {
  return {
    fontName: { family: "Inter", style: "Regular" },
    fontSize: 12,
    fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0 }, opacity: 1, visible: true, blendMode: "NORMAL" }],
    textDecoration: "NONE",
    textCase: "ORIGINAL",
    letterSpacing: { unit: "PERCENT", value: 0 },
    lineHeight: { unit: "AUTO" },
    textStyleId: "",
    fillStyleId: "",
    boundVariables: {},
    hyperlink: null,
    listOptions: { type: "NONE" },
    indentation: 0,
    paragraphSpacing: 0,
    ...overrides,
  }
}

function hasInstanceAncestor(node: FakeNode): boolean {
  for (let parent = node.parent; parent !== null; parent = parent.parent) {
    if (parent.type === "INSTANCE") {
      return true
    }
  }
  return false
}

// skipInvisibleInstanceChildren: invisible nodes inside instances (and everything under them) are skipped.
function isSkippedInvisible(node: FakeNode): boolean {
  if (current === null || !current.skipInvisibleInstanceChildren) {
    return false
  }
  for (let walk: FakeNode | null = node; walk !== null; walk = walk.parent) {
    if (walk.visible === false && hasInstanceAncestor(walk)) {
      return true
    }
  }
  return false
}

function preorder(node: FakeNode, out: FakeNode[]): void {
  for (const child of node.children) {
    out.push(child)
    preorder(child, out)
  }
}

export function createNode(type: string, id: string, name: string, children: FakeNode[] = [], extra: Record<string, unknown> = {}): FakeNode {
  const own = new Map<string, string>()
  const dataKey = (namespace: string, key: string) => namespace + "/" + key
  let relaunch: Record<string, string> = {}
  const node: FakeNode = {
    id,
    type,
    name,
    parent: null,
    removed: false,
    visible: true,
    locked: false,
    allChildren: [],
    inheritFrom: null,
    get children(): FakeNode[] {
      return Object.freeze(node.allChildren.filter((child) => !isSkippedInvisible(child))) as FakeNode[]
    },
    getSharedPluginData(namespace: string, key: string): string {
      const value = own.get(dataKey(namespace, key))
      if (value !== undefined) {
        return value
      }
      return node.inheritFrom !== null ? node.inheritFrom.getSharedPluginData(namespace, key) : ""
    },
    setSharedPluginData(namespace: string, key: string, value: string): void {
      if (current !== null && current.pluginDataWriteError !== null) {
        throw new Error(current.pluginDataWriteError)
      }
      if (value === "") {
        own.delete(dataKey(namespace, key))
      } else {
        own.set(dataKey(namespace, key), value)
      }
    },
    getSharedPluginDataKeys(namespace: string): string[] {
      return Object.freeze([...own.keys()].filter((entry) => entry.startsWith(namespace + "/")).map((entry) => entry.slice(namespace.length + 1))) as string[]
    },
    setRelaunchData: vi.fn((data: Record<string, string>) => {
      relaunch = { ...data }
    }),
    getRelaunchData: () => handOut(relaunch),
    findAllWithCriteria(criteria) {
      const all: FakeNode[] = []
      preorder(node, all)
      return frozenList(all.filter((candidate) => {
        if (criteria.types !== undefined && !criteria.types.includes(candidate.type)) {
          return false
        }
        if (criteria.sharedPluginData !== undefined) {
          const { namespace, keys } = criteria.sharedPluginData
          if (current !== null && current.criteriaSkipsInherited && candidate.inheritFrom !== null) {
            const ownKeys = candidate.getSharedPluginDataKeys(namespace)
            return (keys ?? []).some((key) => ownKeys.includes(key))
          }
          return (keys ?? []).some((key) => candidate.getSharedPluginData(namespace, key) !== "")
        }
        return true
      }))
    },
    findAll(callback) {
      const all: FakeNode[] = []
      preorder(node, all)
      return frozenList(callback === undefined ? all : all.filter(callback))
    },
    appendChild(child: FakeNode): void {
      if (child.parent !== null) {
        child.parent.allChildren = child.parent.allChildren.filter((entry) => entry !== child)
      }
      child.parent = node
      node.allChildren.push(child)
    },
    insertChild(index: number, child: FakeNode): void {
      if (child.parent !== null) {
        child.parent.allChildren = child.parent.allChildren.filter((entry) => entry !== child)
      }
      child.parent = node
      const at = Math.max(0, Math.min(index, node.allChildren.length))
      node.allChildren.splice(at, 0, child)
    },
    clone(): FakeNode {
      return cloneNode(node)
    },
    remove(): void {
      node.removed = true
      if (node.parent !== null) {
        node.parent.allChildren = node.parent.allChildren.filter((entry) => entry !== node)
      }
    },
  }
  // Test-only access to the node's own plugin data and relaunch data (clone copies them).
  Object.defineProperty(node, "__ownData", { value: () => new Map(own), enumerable: false })
  Object.defineProperty(node, "__relaunch", { value: () => ({ ...relaunch }), enumerable: false })
  for (const child of children) {
    node.appendChild(child)
  }
  for (const [key, value] of Object.entries(extra)) {
    defineValue(node, key, value)
  }
  liveNodes.add(node)
  registry.set(id, node)
  return node
}

// Properties every node gets from createNode (or fakeText's accessors); clone() copies the rest as data.
const BASE_KEYS = new Set([
  "id", "type", "name", "parent", "removed", "visible", "locked", "children", "allChildren", "inheritFrom",
  "characters", "styles", "fontName", "textAutoResize", "overrides", "mainComponent", "getMainComponentAsync",
])

interface CloneRoot { sourceId: string; cloneId: string }

function freshCloneId(): string {
  cloneCounter++
  return String(8000 + cloneCounter) + ":" + String(cloneCounter)
}

// Figma names a sublayer of an instance "I" + instance id + ";" + the path inside the main component; inside a
// copied instance the path stays and the instance id is the copy's.
function cloneIdFor(source: FakeNode, root: CloneRoot | null): string {
  if (root === null) {
    return freshCloneId()
  }
  const prefix = "I" + root.sourceId + ";"
  const path = source.id.startsWith(prefix) ? source.id.slice(prefix.length) : source.id.replace(/^I/, "")
  return "I" + root.cloneId + ";" + path
}

// node.clone() (Figma: the duplicate is parented under figma.currentPage; nested components become instances of
// the original component; plugin data, relaunch data and overrides travel with the copy).
export function cloneNode(source: FakeNode): FakeNode {
  const copy = cloneTree(source, null, true, false)
  if (current !== null) {
    current.currentPage.appendChild(copy)
  }
  return copy
}

function cloneTree(source: FakeNode, root: CloneRoot | null, isRoot: boolean, inheritOnly: boolean): FakeNode {
  const id = cloneIdFor(source, root)
  const asInstance = !isRoot && root === null && source.type === "COMPONENT"
  const type = asInstance ? "INSTANCE" : source.type
  const extra: Record<string, unknown> = {}
  for (const key of Object.keys(source)) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key)
    if (BASE_KEYS.has(key) || descriptor === undefined) {
      continue
    }
    if (descriptor.get !== undefined && handOutGetters.has(descriptor.get)) {
      extra[key] = clone(descriptor.get())
      continue
    }
    if (descriptor.get !== undefined || typeof descriptor.value === "function") {
      continue
    }
    extra[key] = clone(descriptor.value)
  }
  if (asInstance) {
    delete extra.remote
  }
  let copy: FakeNode
  if (source.type === "TEXT") {
    const text = source as FakeText
    const fake = fakeText(id, text.characters, { ...extra, textAutoResize: text.textAutoResize })
    fake.styles = clone(text.styles)
    copy = fake
  } else {
    copy = createNode(type, id, source.name, [], extra)
  }
  copy.name = source.name
  copy.visible = source.visible
  copy.locked = source.locked
  if (type === "INSTANCE") {
    const instance = copy as FakeInstance
    const sourceOverrides = asInstance ? [] : ((source as FakeInstance).overrides ?? [])
    const nextRoot = root ?? { sourceId: source.id, cloneId: id }
    defineValue(instance, "overrides", sourceOverrides.map((entry) => ({ id: cloneIdFor({ id: entry.id } as FakeNode, nextRoot), overriddenFields: entry.overriddenFields.slice() })))
    instance.mainComponent = asInstance ? source : ((source as FakeInstance).mainComponent ?? null)
    instance.getMainComponentAsync = vi.fn(async () => instance.mainComponent)
  }
  // Sublayers of a component that became an instance show the component's data (inherited); everything else keeps
  // its own copy.
  if (inheritOnly) {
    copy.inheritFrom = source
  } else {
    const data = (source as unknown as { __ownData(): Map<string, string> }).__ownData()
    for (const [entry, value] of data) {
      const at = entry.indexOf("/")
      copy.setSharedPluginData(entry.slice(0, at), entry.slice(at + 1), value)
    }
    copy.inheritFrom = source.inheritFrom
    const relaunch = (source as unknown as { __relaunch(): Record<string, string> }).__relaunch()
    if (Object.keys(relaunch).length > 0) {
      copy.setRelaunchData(relaunch)
      copy.setRelaunchData.mockClear()
    }
  }
  const childRoot = type === "INSTANCE" ? (root ?? { sourceId: source.id, cloneId: id }) : root
  for (const child of source.allChildren) {
    copy.appendChild(cloneTree(child, childRoot, false, inheritOnly || asInstance))
  }
  return copy
}

function requireLoaded(font: FakeFont): void {
  if (current !== null && current.strictFonts && !current.loadedFonts.has(fontId(font))) {
    throw new Error(`Cannot write to node with unloaded font "${font.family} ${font.style}"`)
  }
}

export function fakeText(id: string, characters: string, extra: Record<string, unknown> = {}): FakeText {
  const base = createNode("TEXT", id, characters)
  const text = base as FakeText
  let value = characters
  let styles: FakeStyle[] = Array.from({ length: characters.length }, () => defaultStyle())
  let baseStyle = defaultStyle()
  const rangeStyles = (start: number, end: number) => styles.slice(start, end)
  const setRange = (field: keyof FakeStyle) =>
    vi.fn((start: number, end: number, next: unknown) => {
      if (start < 0 || end > value.length || start > end) {
        throw new Error(`Range ${start}-${end} is out of bounds`)
      }
      if (field === "fontName") {
        requireLoaded(next as FakeFont)
      }
      const detach = TEXT_STYLE_FIELDS.has(field) ? { textStyleId: "" } : {}
      for (let i = start; i < end; i++) {
        styles[i] = { ...styles[i], [field]: clone(next), ...detach }
      }
    })
  Object.defineProperties(text, {
    characters: {
      get: () => value,
      set: (next: string) => {
        const fonts = value.length === 0 ? [baseStyle.fontName] : uniqueFonts(styles)
        fonts.forEach(requireLoaded)
        const first = styles[0] ?? baseStyle
        baseStyle = first
        value = next
        styles = Array.from({ length: next.length }, () => ({ ...first }))
        if (text.autoRename) {
          text.name = next
        }
      },
      enumerable: true,
      configurable: true,
    },
    styles: {
      get: () => styles,
      set: (next: FakeStyle[]) => {
        styles = next
        baseStyle = next[0] ?? baseStyle
      },
      enumerable: true,
      configurable: true,
    },
    fontName: {
      get: () => {
        const fonts = value.length === 0 ? [baseStyle.fontName] : uniqueFonts(styles)
        return fonts.length === 1 ? handOut(fonts[0]) : (current?.mixed ?? Symbol("mixed"))
      },
      enumerable: true,
      configurable: true,
    },
  })
  // Setting textAutoResize needs the fonts loaded (as in Figma). Switching to "HEIGHT" keeps the width and takes
  // the height the test gave as `measuredHeight` (the text's height when it wraps freely), if any.
  let autoResize = typeof extra.textAutoResize === "string" ? extra.textAutoResize : "WIDTH_AND_HEIGHT"
  Object.defineProperty(text, "textAutoResize", {
    get: () => autoResize,
    set: (next: string) => {
      const fonts = value.length === 0 ? [baseStyle.fontName] : uniqueFonts(styles)
      fonts.forEach(requireLoaded)
      autoResize = next
      const measured = (text as Record<string, unknown>).measuredHeight
      if (next === "HEIGHT" && typeof measured === "number") {
        text.height = measured
      }
    },
    enumerable: true,
    configurable: true,
  })
  defineValue(text, "componentPropertyReferences", null)
  defineValue(text, "boundVariables", {})
  defineValue(text, "absoluteBoundingBox", { x: 0, y: 0, width: 100, height: 20 })
  Object.assign(text, {
    autoRename: true,
    hasMissingFont: false,
    width: 100,
    height: 20,
    textTruncation: "DISABLED",
    maxLines: null,
    getRangeAllFontNames(start: number, end: number): FakeFont[] {
      if (start >= end) {
        throw new Error("getRangeAllFontNames: empty range")
      }
      return handOut(uniqueFonts(rangeStyles(start, end)))
    },
    getStyledTextSegments(fields: string[], start = 0, end = value.length): Record<string, unknown>[] {
      const segments: Record<string, unknown>[] = []
      for (let i = start; i < end; i++) {
        const picked: Record<string, unknown> = {}
        for (const field of fields) {
          picked[field] = (styles[i] as unknown as Record<string, unknown>)[field]
        }
        const last = segments[segments.length - 1]
        if (last !== undefined && fields.every((field) => JSON.stringify(last[field]) === JSON.stringify(picked[field]))) {
          last.end = i + 1
          last.characters = value.slice(last.start as number, i + 1)
        } else {
          segments.push({ characters: value.slice(i, i + 1), start: i, end: i + 1, ...picked })
        }
      }
      return handOut(clone(segments))
    },
    setRangeFontName: setRange("fontName"),
    setRangeFontSize: setRange("fontSize"),
    setRangeTextDecoration: setRange("textDecoration"),
    setRangeTextCase: setRange("textCase"),
    setRangeLetterSpacing: setRange("letterSpacing"),
    setRangeLineHeight: setRange("lineHeight"),
    setRangeFills: setRange("fills"),
    setRangeHyperlink: setRange("hyperlink"),
    setRangeListOptions: setRange("listOptions"),
    setRangeIndentation: setRange("indentation"),
    setRangeParagraphSpacing: setRange("paragraphSpacing"),
    setRangeTextStyleIdAsync: vi.fn(async (start: number, end: number, styleId: string) => {
      const style = current?.textStyles.get(styleId) ?? {}
      for (let i = start; i < end; i++) {
        styles[i] = { ...styles[i], ...style, textStyleId: styleId }
      }
    }),
    setRangeFillStyleIdAsync: vi.fn(async (start: number, end: number, styleId: string) => {
      const style = current?.fillStyles.get(styleId)
      for (let i = start; i < end; i++) {
        styles[i] = { ...styles[i], ...(style === undefined ? {} : { fills: style }), fillStyleId: styleId }
      }
    }),
    setRangeBoundVariable: vi.fn((start: number, end: number, field: string, variable: { id: string } | null) => {
      for (let i = start; i < end; i++) {
        const bound = { ...styles[i].boundVariables }
        if (variable === null) {
          delete bound[field]
        } else {
          bound[field] = { type: "VARIABLE_ALIAS", id: variable.id }
        }
        styles[i] = { ...styles[i], boundVariables: bound, textStyleId: "" }
      }
    }),
  })
  for (const [key, entry] of Object.entries(extra)) {
    if (key === "textAutoResize") {
      continue
    }
    defineValue(text, key, entry)
  }
  return text
}

// Figma's instance text: a sublayer shows the characters of the node it was instanced from (`source`, usually the
// main component's text) until its own characters are written. That write is listed as a `characters` override
// on `instance` (when its overrides are a plain list), as Figma does.
export function followText(sublayer: FakeText, source: FakeText, instance: FakeInstance | null = null): void {
  const descriptor = Object.getOwnPropertyDescriptor(sublayer, "characters") as PropertyDescriptor
  const read = () => descriptor.get?.call(sublayer) as string
  const write = (next: string) => descriptor.set?.call(sublayer, next)
  let overridden = false
  const sync = () => {
    if (overridden || read() === source.characters) {
      return
    }
    const strict = current?.strictFonts ?? false
    const name = sublayer.name
    if (current !== null) current.strictFonts = false
    try {
      write(source.characters)
    } finally {
      if (current !== null) current.strictFonts = strict
      sublayer.name = name
    }
  }
  Object.defineProperty(sublayer, "characters", {
    get: () => {
      sync()
      return read()
    },
    set: (next: string) => {
      write(next)
      overridden = true
      const list = instance === null ? undefined : storedOverrides(instance)
      if (list !== undefined) {
        const at = list.findIndex((override) => override.id === sublayer.id)
        if (at < 0) {
          list.push({ id: sublayer.id, overriddenFields: ["characters"] })
        } else if (!list[at].overriddenFields.includes("characters")) {
          list[at] = { id: sublayer.id, overriddenFields: [...list[at].overriddenFields, "characters"] }
        }
      }
    },
    enumerable: true,
    configurable: true,
  })
}

// The instance's own (mutable) override list behind the frozen `overrides` it hands out; for overrides given as a
// function, the list that function returns. undefined when the overrides are not a list.
function storedOverrides(instance: FakeInstance): FakeOverride[] | undefined {
  const stored = (instance as unknown as { __stored_overrides?: () => unknown }).__stored_overrides?.()
  const list = typeof stored === "function" ? (stored as () => unknown)() : stored
  return Array.isArray(list) ? (list as FakeOverride[]) : undefined
}

// Setting a property that a text style governs detaches the style from that range, as in Figma (also when the
// value equals the style's). Every variable-bindable text field is one of them.
const TEXT_STYLE_FIELDS: ReadonlySet<keyof FakeStyle> = new Set<keyof FakeStyle>(["fontName", "fontSize", "letterSpacing", "lineHeight", "textCase", "textDecoration", "paragraphSpacing"])

function uniqueFonts(styles: FakeStyle[]): FakeFont[] {
  const seen = new Map<string, FakeFont>()
  for (const style of styles) {
    seen.set(fontId(style.fontName), style.fontName)
  }
  return [...seen.values()]
}

export function fakeFrame(id: string, name: string, children: FakeNode[] = [], extra: Record<string, unknown> = {}): FakeNode {
  return createNode("FRAME", id, name, children, extra)
}

export function fakeSection(id: string, name: string, children: FakeNode[] = []): FakeNode {
  return createNode("SECTION", id, name, children)
}

export function fakeGroup(id: string, name: string, children: FakeNode[] = []): FakeNode {
  return createNode("GROUP", id, name, children)
}

export function fakeComponent(id: string, name: string, children: FakeNode[] = [], extra: Record<string, unknown> = {}): FakeNode {
  return createNode("COMPONENT", id, name, children, { remote: false, ...extra })
}

export function fakeComponentSet(id: string, name: string, children: FakeNode[] = []): FakeNode {
  return createNode("COMPONENT_SET", id, name, children, { remote: false })
}

export function fakeInstance(
  id: string,
  name: string,
  children: FakeNode[] = [],
  options: { overrides?: FakeOverride[] | (() => FakeOverride[]); mainComponent?: FakeNode | null } = {},
): FakeInstance {
  const instance = createNode("INSTANCE", id, name, children) as FakeInstance
  // A function stands for overrides Figma computes on every read (it may throw, as an unreadable list does).
  defineValue(instance, "overrides", options.overrides ?? [])
  instance.mainComponent = options.mainComponent ?? null
  instance.getMainComponentAsync = vi.fn(async () => instance.mainComponent)
  return instance
}

export function fakePage(id: string, name: string, children: FakeNode[] = []): FakeNode {
  const page = createNode("PAGE", id, name, children, { selection: [] as FakeNode[] })
  page.loadAsync = vi.fn(async () => {})
  return page
}

export function fakeDocument(name: string, pages: FakeNode[]): FakeNode {
  return createNode("DOCUMENT", "0:0", name, pages)
}

export interface FigmaMock {
  mixed: symbol
  editorType: string
  mode: string
  command: string
  apiVersion: string
  vscode: unknown
  skipInvisibleInstanceChildren: boolean
  strictFonts: boolean
  criteriaSkipsInherited: boolean
  pluginDataWriteError: string | null
  loadedFonts: Set<string>
  missingFonts: Set<string>
  textStyles: Map<string, Partial<FakeStyle>>
  fillStyles: Map<string, unknown[]>
  variablesById: Map<string, { id: string; name: string }>
  listeners: Map<string, (() => void)[]>
  notify: MockFn
  commitUndo: MockFn
  openExternal: MockFn
  showUI: MockFn
  loadFontAsync: MockFn
  ui: { postMessage: MockFn; onmessage: unknown; resize: MockFn }
  clientStorage: {
    data: Map<string, unknown>
    failWrites: boolean
    getAsync: MockFn
    setAsync: MockFn
    deleteAsync: MockFn
    keysAsync: MockFn
  }
  codegen: { on: MockFn }
  viewport: { scrollAndZoomIntoView: MockFn }
  variables: { getVariableByIdAsync: MockFn }
  currentPage: FakeNode
  root: FakeNode
  getNodeByIdAsync: MockFn
  setCurrentPageAsync: MockFn
  on: MockFn
  emit(event: string): void
  [key: string]: unknown
}

export function installFigma(overrides: Record<string, unknown> = {}): FigmaMock {
  const page = fakePage("0:1", "Page 1")
  const root = fakeDocument("File", [page])
  const storage = new Map<string, unknown>()
  const figma: FigmaMock = {
    mixed: Symbol("mixed"),
    editorType: "figma",
    mode: "default",
    command: "",
    apiVersion: "1.0.0",
    vscode: undefined,
    skipInvisibleInstanceChildren: false,
    strictFonts: true,
    criteriaSkipsInherited: false,
    pluginDataWriteError: null,
    loadedFonts: new Set<string>(),
    missingFonts: new Set<string>(),
    textStyles: new Map(),
    fillStyles: new Map(),
    variablesById: new Map(),
    listeners: new Map(),
    notify: vi.fn(),
    commitUndo: vi.fn(),
    openExternal: vi.fn(),
    showUI: vi.fn(),
    loadFontAsync: vi.fn(async (font: FakeFont) => {
      if (figma.missingFonts.has(fontId(font))) {
        throw new Error(`The font "${font.family} ${font.style}" could not be loaded`)
      }
      figma.loadedFonts.add(fontId(font))
    }),
    ui: { postMessage: vi.fn(), onmessage: undefined, resize: vi.fn() },
    clientStorage: {
      data: storage,
      failWrites: false,
      getAsync: vi.fn(async (key: string) => (storage.has(key) ? handOut(clone(storage.get(key))) : undefined)),
      setAsync: vi.fn(async (key: string, value: unknown) => {
        if (figma.clientStorage.failWrites) {
          throw new Error("Storage limit exceeded")
        }
        storage.set(key, clone(value))
      }),
      deleteAsync: vi.fn(async (key: string) => {
        storage.delete(key)
      }),
      keysAsync: vi.fn(async () => Object.freeze([...storage.keys()])),
    },
    codegen: { on: vi.fn() },
    viewport: { scrollAndZoomIntoView: vi.fn() },
    variables: { getVariableByIdAsync: vi.fn(async (id: string) => figma.variablesById.get(id) ?? null) },
    currentPage: page,
    root,
    getNodeByIdAsync: vi.fn(async (id: string) => {
      const node = registry.get(id)
      if (node === undefined || node.removed || isSkippedInvisible(node)) {
        return null
      }
      return node
    }),
    setCurrentPageAsync: vi.fn(async (next: FakeNode) => {
      figma.currentPage = next
    }),
    on: vi.fn((event: string, callback: () => void) => {
      figma.listeners.set(event, [...(figma.listeners.get(event) ?? []), callback])
    }),
    emit(event: string): void {
      for (const callback of figma.listeners.get(event) ?? []) {
        callback()
      }
    },
    ...overrides,
  }
  current = figma
  const globals = globalThis as unknown as Record<string, unknown>
  globals.figma = figma
  globals.__html__ = "/*ui*/"
  return figma
}

export function uninstallFigma(): void {
  const globals = globalThis as unknown as Record<string, unknown>
  delete globals.figma
  delete globals.__html__
  current = null
  registry.clear()
  cloneCounter = 0
  vi.restoreAllMocks()
}

// Puts nodes on the current page (children) and optionally selects some of them.
export function onPage(figma: FigmaMock, nodes: FakeNode[], selection: FakeNode[] = []): FakeNode {
  for (const node of nodes) {
    figma.currentPage.appendChild(node)
  }
  figma.currentPage.selection = selection
  return figma.currentPage
}

export function loadFont(figma: FigmaMock, font: FakeFont = { family: "Inter", style: "Regular" }): void {
  figma.loadedFonts.add(fontId(font))
}

export function posted(figma: FigmaMock): Record<string, unknown>[] {
  return figma.ui.postMessage.mock.calls.map((call) => call[0] as Record<string, unknown>)
}

export function postedOfType(figma: FigmaMock, type: string): Record<string, unknown>[] {
  return posted(figma).filter((message) => message.type === type)
}
