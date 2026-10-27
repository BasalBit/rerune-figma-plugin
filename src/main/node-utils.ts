import { DATA_KEYS, PLUGIN_DATA_NAMESPACE, SCAN_YIELD_EVERY_CHILDREN, SCAN_YIELD_EVERY_ROOTS } from "../shared/constants"
import { isOwnLangCopy } from "../shared/plugin-data"

export type OverrideList = ReadonlyArray<{ readonly id: string; readonly overriddenFields: ReadonlyArray<string> }>

// Per-scan caches (§7.9): instance overrides, main-component names, hidden/locked ancestors, language copies,
// and node lookups by id (the nodes instance sublayers take their text from).
export interface NodeCaches {
  overrides: Map<string, OverrideList | null>
  nodes: Map<string, Promise<BaseNode | null>>
  componentNames: Map<string, Promise<string | null>>
  hidden: Map<string, boolean>
  locked: Map<string, boolean>
  langCopy: Map<string, boolean>
}

export interface OverrideFlags {
  ownPluginDataOverride: boolean | null
  textOverridden: boolean
}

const TOP_FRAME_TYPES = ["FRAME", "COMPONENT", "COMPONENT_SET", "INSTANCE"]
const PARENT_NAMES_MAX = 5

export function createNodeCaches(): NodeCaches {
  return { overrides: new Map(), componentNames: new Map(), hidden: new Map(), locked: new Map(), langCopy: new Map(), nodes: new Map() }
}

// figma.getNodeByIdAsync, cached per id for one scan or operation; a failed lookup is null.
export function lookupNode(id: string, caches: NodeCaches): Promise<BaseNode | null> {
  let pending = caches.nodes.get(id)
  if (pending === undefined) {
    pending = figma.getNodeByIdAsync(id).then(
      (node) => (node === null || node.removed ? null : node),
      () => null,
    )
    caches.nodes.set(id, pending)
  }
  return pending
}

let invisibleChildrenDepth = 0
let savedSkipInvisible = true

// Runs `work` with figma.skipInvisibleInstanceChildren = false (§7.14 reset, §7.15) and restores the value seen
// by the outermost caller when the last overlapping run ends, so two overlapping resets cannot leave it false.
export async function withInvisibleInstanceChildren<T>(work: () => Promise<T>): Promise<T> {
  if (invisibleChildrenDepth === 0) {
    savedSkipInvisible = figma.skipInvisibleInstanceChildren
  }
  invisibleChildrenDepth++
  figma.skipInvisibleInstanceChildren = false
  try {
    return await work()
  } finally {
    invisibleChildrenDepth--
    if (invisibleChildrenDepth === 0) {
      figma.skipInvisibleInstanceChildren = savedSkipInvisible
    }
  }
}

export function yieldToCanvas(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

export function isTextNode(node: BaseNode | null | undefined): node is TextNode {
  return node !== null && node !== undefined && node.type === "TEXT"
}

function isContainerBoundary(node: BaseNode | null): boolean {
  return node === null || node.type === "PAGE" || node.type === "DOCUMENT"
}

export function pageOf(node: BaseNode): PageNode | null {
  let current: BaseNode | null = node
  while (current !== null && current.type !== "PAGE") {
    current = current.parent
  }
  return current as PageNode | null
}

// Ancestors nearest first, up to (not including) the page.
export function ancestorsOf(node: BaseNode): BaseNode[] {
  const result: BaseNode[] = []
  for (let current = node.parent; !isContainerBoundary(current); current = (current as BaseNode).parent) {
    result.push(current as BaseNode)
  }
  return result
}

// §7.9: walk up while the parent is not a PAGE or SECTION; not figma's getTopLevelFrame().
export function topFrameOf(node: BaseNode): SceneNode | null {
  let current: BaseNode = node
  while (current.parent !== null && current.parent.type !== "PAGE" && current.parent.type !== "SECTION" && current.parent.type !== "DOCUMENT") {
    current = current.parent
  }
  if (current === node || current.parent === null) {
    return null
  }
  return TOP_FRAME_TYPES.includes(current.type) ? (current as SceneNode) : null
}

export function parentNamesOf(node: BaseNode): string[] {
  return ancestorsOf(node)
    .filter((ancestor) => ancestor.type !== "SECTION")
    .slice(0, PARENT_NAMES_MAX)
    .map((ancestor) => ancestor.name)
}

export function instanceAncestorsOf(node: BaseNode): InstanceNode[] {
  return ancestorsOf(node).filter((ancestor): ancestor is InstanceNode => ancestor.type === "INSTANCE")
}

export function nearestComponentOf(node: BaseNode): ComponentNode | null {
  for (const ancestor of ancestorsOf(node)) {
    if (ancestor.type === "COMPONENT") {
      return ancestor as ComponentNode
    }
  }
  return null
}

// Library (remote) components are read-only in this file.
export function isInRemoteComponent(node: BaseNode): boolean {
  const component = nearestComponentOf(node)
  return component !== null && component.remote
}

export function readOverrides(instance: InstanceNode, caches: NodeCaches): OverrideList | null {
  if (caches.overrides.has(instance.id)) {
    return caches.overrides.get(instance.id) ?? null
  }
  let list: OverrideList | null
  try {
    list = instance.overrides.map((entry) => ({ id: entry.id, overriddenFields: entry.overriddenFields.slice() }))
  } catch {
    list = null
  }
  caches.overrides.set(instance.id, list)
  return list
}

// D44 inputs for classifyLink: does an INSTANCE ancestor list a pluginData / characters override for this node?
export function overrideFlags(node: BaseNode, caches: NodeCaches): OverrideFlags {
  if (node.id.charAt(0) !== "I") {
    return { ownPluginDataOverride: false, textOverridden: false }
  }
  let own = false
  let text = false
  let unreadable = false
  for (const instance of instanceAncestorsOf(node)) {
    const list = readOverrides(instance, caches)
    if (list === null) {
      unreadable = true
      continue
    }
    for (const entry of list) {
      if (entry.id !== node.id) {
        continue
      }
      if (entry.overriddenFields.includes("pluginData")) {
        own = true
      }
      if (entry.overriddenFields.includes("characters")) {
        text = true
      }
    }
  }
  return { ownPluginDataOverride: own ? true : unreadable ? null : false, textOverridden: text }
}

function inheritedFlag(node: BaseNode, cache: Map<string, boolean>, own: (node: BaseNode) => boolean): boolean {
  const path: BaseNode[] = []
  let result = false
  let current: BaseNode | null = node
  while (!isContainerBoundary(current)) {
    const known = cache.get((current as BaseNode).id)
    if (known !== undefined) {
      result = known
      break
    }
    path.push(current as BaseNode)
    if (own(current as BaseNode)) {
      result = true
      break
    }
    current = (current as BaseNode).parent
  }
  // Every node on the walked path is hidden/locked when the first flagged node is at or above it.
  for (const entry of path) {
    cache.set(entry.id, result)
  }
  return result
}

export function isHidden(node: BaseNode, caches: NodeCaches): boolean {
  return inheritedFlag(node, caches.hidden, (entry) => (entry as SceneNode).visible === false)
}

export function isLocked(node: BaseNode, caches: NodeCaches): boolean {
  return inheritedFlag(node, caches.locked, (entry) => (entry as SceneNode).locked === true)
}

export function isInLanguageCopy(node: BaseNode, caches: NodeCaches): boolean {
  const frame = topFrameOf(node)
  if (frame === null) {
    return false
  }
  const known = caches.langCopy.get(frame.id)
  if (known !== undefined) {
    return known
  }
  let marked: boolean
  try {
    marked = isOwnLangCopy(frame.getSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.langCopy), frame.id)
  } catch {
    marked = false
  }
  caches.langCopy.set(frame.id, marked)
  return marked
}

function variantAwareName(component: BaseNode): string {
  const parent = component.parent
  return parent !== null && parent.type === "COMPONENT_SET" ? parent.name : component.name
}

async function mainComponentName(instance: InstanceNode): Promise<string | null> {
  try {
    const main = await instance.getMainComponentAsync()
    return main === null ? null : variantAwareName(main)
  } catch {
    return null
  }
}

// Nearest INSTANCE → its main component (variant → the component set's name); else nearest COMPONENT/COMPONENT_SET.
export function componentNameOf(node: BaseNode, caches: NodeCaches): Promise<string | null> {
  for (const ancestor of ancestorsOf(node)) {
    if (ancestor.type === "INSTANCE") {
      let pending = caches.componentNames.get(ancestor.id)
      if (pending === undefined) {
        pending = mainComponentName(ancestor as InstanceNode)
        caches.componentNames.set(ancestor.id, pending)
      }
      return pending
    }
    if (ancestor.type === "COMPONENT") {
      return Promise.resolve(variantAwareName(ancestor))
    }
    if (ancestor.type === "COMPONENT_SET") {
      return Promise.resolve(ancestor.name)
    }
  }
  return Promise.resolve(null)
}

export function isBoundToVariable(node: TextNode): boolean {
  const bound = node.boundVariables as { characters?: unknown } | undefined
  return bound !== undefined && bound !== null && !!bound.characters
}

export function isBoundToComponentProperty(node: TextNode): boolean {
  const references = node.componentPropertyReferences
  return references !== null && references !== undefined && !!references.characters
}

// TEXT nodes under the given roots (roots included), one findAllWithCriteria per child, yielding every 25
// roots and every 10 children of a root (§7.9).
export async function collectTextNodes(roots: readonly BaseNode[], isStale: () => boolean = () => false): Promise<TextNode[] | null> {
  const seen = new Set<string>()
  const result: TextNode[] = []
  const add = (node: BaseNode) => {
    if (node.type === "TEXT" && !seen.has(node.id)) {
      seen.add(node.id)
      result.push(node as TextNode)
    }
  }
  for (let r = 0; r < roots.length; r++) {
    if (r > 0 && r % SCAN_YIELD_EVERY_ROOTS === 0) {
      await yieldToCanvas()
      if (isStale()) {
        return null
      }
    }
    const root = roots[r]
    if (root.removed) {
      continue
    }
    add(root)
    if (!("children" in root)) {
      continue
    }
    const children = (root as BaseNode & ChildrenMixin).children
    for (let index = 0; index < children.length; index++) {
      if (index > 0 && index % SCAN_YIELD_EVERY_CHILDREN === 0) {
        await yieldToCanvas()
        if (isStale()) {
          return null
        }
      }
      const child = children[index]
      if (child.removed) {
        continue
      }
      add(child)
      if ("findAllWithCriteria" in child) {
        for (const text of child.findAllWithCriteria({ types: ["TEXT"] })) {
          add(text)
        }
      }
    }
  }
  return result
}
