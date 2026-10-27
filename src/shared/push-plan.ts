import type { FigmaKeyRef, FigmaPushResult, PushItemReason, PushItemWire } from "./api-types"
import { PUSH_CHUNK_SIZE } from "./constants"
import { src } from "./hash"
import { keyNameIssues, uniqueKeyName, type ResolvedCaseStyle } from "./key-names"
import type { LinkApplyItem, ScannedNode, Scope, TextApplyItem } from "./messages"
import { computeSyncState, layerText, type RemoteKeyState } from "./sync-state"
import { normalizeDesignText, utf16Length } from "./text"

export type RemoteWithMaxLength = RemoteKeyState & { maxLength: number | null }
export type CreateOrigin =
  | { kind: "unlinked" }
  | { kind: "divergent"; keyId: string; variant: number }
  | { kind: "copied"; nodeId: string }
  | { kind: "missing"; keyId: string }
export type UpdateOrigin =
  | { kind: "changed" }
  | { kind: "divergent"; variant: number }
  | { kind: "conflict"; figmaText: string }

export interface PlanCreate {
  ref: string; nodeIds: string[]; text: string; name: string; nameIssues: string[]; description: string; selected: boolean
  match: { candidates: FigmaKeyRef[]; decision: "link" | "create" | null; linkKeyId: string | null }
  origin: CreateOrigin
}
export interface PlanUpdate { ref: string; keyId: string; keyName: string; nodeIds: string[]; text: string; expectedText: string; origin: UpdateOrigin }
export interface PlanDivergent {
  keyId: string; keyName: string; remoteText: string
  variants: { text: string; nodeIds: string[]; decision: "winner" | "new_key" | "leave" | null }[]
}
export interface PlanConflict { keyId: string; keyName: string; nodeIds: string[]; figmaText: string; remoteText: string; decision: "skip" | "overwrite" | "take_rerune" }
export interface PlanPull { keyId: string; keyName: string; nodeIds: string[]; remoteText: string }
export interface PlanCopied { nodeId: string; keyId: string; keyName: string; decision: "keep" | "new_key" | null }
export interface PlanMissing { keyId: string; keyName: string; nodeIds: string[]; text: string; decision: "skip" | "recreate" | "unlink" }

export interface PushPlan {
  creates: PlanCreate[]
  updates: PlanUpdate[]
  divergent: PlanDivergent[]
  conflicts: PlanConflict[]
  pulls: PlanPull[]
  copied: PlanCopied[]
  missing: PlanMissing[]
  unchanged: number; readonly: number; otherProject: number; invalid: number; unknown: number
  blockedByPreview: string[]
  maxLengthViolations: { ref: string; length: number; maxLength: number }[]
}

export interface PushPlanInput {
  projectId: string
  scope: Scope
  nodes: ScannedNode[]
  remote: Map<string, RemoteWithMaxLength>
  textMatches: Map<string, FigmaKeyRef[]>
  groupIdenticalTexts: boolean
  suggestName: (n: ScannedNode) => string
}

export interface PlanContext {
  projectId: string
  nodes: Map<string, ScannedNode>
  remote: Map<string, RemoteWithMaxLength>
  style: ResolvedCaseStyle
  isTaken: (name: string) => boolean
  suggestName: (n: ScannedNode) => string
}

export type PlanDecision =
  | { kind: "create-selected"; ref: string; selected: boolean }
  | { kind: "create-name"; ref: string; name: string }
  | { kind: "create-match"; ref: string; decision: "create" }
  | { kind: "create-match"; ref: string; decision: "link"; key: FigmaKeyRef }
  | { kind: "divergent"; keyId: string; variant: number; decision: "winner" | "new_key" | "leave" | null }
  | { kind: "conflict"; keyId: string; figmaText: string; decision: "skip" | "overwrite" | "take_rerune" }
  | { kind: "copied"; nodeId: string; decision: "keep" | "new_key" | null }
  | { kind: "missing"; keyId: string; decision: "skip" | "recreate" | "unlink" }

export interface PushRequestChunk { items: PushItemWire[]; nodeIdsByRef: Map<string, string[]> }

export interface PushFollowUp {
  linkApplies: LinkApplyItem[]
  mainComponentLinkApplies: LinkApplyItem[]   // nodeId = one inherited sublayer per main; main redirects the write (§7.6)
  conflicts: { ref: string; keyId: string; keyName: string; nodeIds: string[]; text: string; currentText: string }[]
  failures: { ref: string; reason: PushItemReason | null; message: string; keyId: string | null; keyName: string | null; nodeIds: string[] }[]
  quotaExceeded: boolean
}

export const PUSH_REASON_MESSAGES: Record<PushItemReason, string> = {
  duplicate_key: "A key with this name exists.",
  quota_exceeded: "Your plan's key limit is reached.",
  invalid_key_name: "Use letters, digits, _ . - / : and start/end with a letter, digit or _.",
  invalid_text: "ReRune rejected this text.",
  key_disabled: "This key is disabled in ReRune.",
  max_length_exceeded: "Longer than the key's max length ({max}).",
  invalid_placeholder: "Uses a {{placeholder}} the key doesn't define. Add it in ReRune first.",
  key_not_found: "The key no longer exists.",
  not_a_text_key: "This key is a group, not a text key.",
  structured_source: "This key uses a plural or ICU message. Edit it in ReRune.",
  source_changed: "The source text changed in ReRune.",
  internal_error: "ReRune had a problem. Try again.",
}

export function nodeText(node: Pick<ScannedNode, "characters" | "originalCharacters">): string {
  return normalizeDesignText(layerText(node))
}

function emptyPlan(): PushPlan {
  return {
    creates: [],
    updates: [],
    divergent: [],
    conflicts: [],
    pulls: [],
    copied: [],
    missing: [],
    unchanged: 0,
    readonly: 0,
    otherProject: 0,
    invalid: 0,
    unknown: 0,
    blockedByPreview: [],
    maxLengthViolations: [],
  }
}

function addTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key)
  if (list === undefined) {
    map.set(key, [value])
  } else {
    list.push(value)
  }
}

function ids(nodes: readonly ScannedNode[]): string[] {
  return nodes.map((node) => node.nodeId)
}

function keyNameFor(keyId: string, nodes: readonly ScannedNode[], remote: Map<string, RemoteWithMaxLength>): string {
  const name = remote.get(keyId)?.key
  if (name !== null && name !== undefined) {
    return name
  }
  return nodes[0]?.link?.k ?? ""
}

export function writeTargets(nodes: readonly ScannedNode[]): string[] {
  const direct = new Set(nodes.filter((node) => node.linkState !== "inherited").map((node) => node.nodeId))
  const mains = new Set<string>()
  const targets: string[] = []
  for (const node of nodes) {
    if (node.linkState === "inherited" && node.link !== null) {
      if (direct.has(node.link.nid) || mains.has(node.link.nid)) {
        continue
      }
      mains.add(node.link.nid)
    }
    targets.push(node.nodeId)
  }
  return targets
}

export function buildPushPlan(input: PushPlanInput): PushPlan {
  const plan = emptyPlan()
  const createGroups = new Map<string, ScannedNode[]>()
  const linkedGroups = new Map<string, ScannedNode[]>()
  const changedKeys = new Set<string>()
  const conflictGroups = new Map<string, ScannedNode[]>()
  const pullGroups = new Map<string, ScannedNode[]>()
  const missingGroups = new Map<string, ScannedNode[]>()

  for (const node of input.nodes) {
    if (node.preview !== null) {
      plan.blockedByPreview.push(node.nodeId)
    }
    const remote = node.link !== null ? input.remote.get(node.link.id) : undefined
    const state = computeSyncState(input.projectId, node, remote)
    const link = node.link
    switch (state) {
      case "unlinked": {
        const text = nodeText(node)
        if (text !== "") {
          addTo(createGroups, input.groupIdenticalTexts ? "t:" + text : "n:" + node.nodeId, node)
        }
        break
      }
      case "invalid_link":
        plan.invalid++
        break
      case "other_project":
        plan.otherProject++
        break
      case "unknown":
        plan.unknown++
        break
      case "readonly":
        plan.readonly++
        break
      case "copied":
        if (link !== null) {
          plan.copied.push({ nodeId: node.nodeId, keyId: link.id, keyName: remote?.key ?? link.k, decision: null })
        }
        break
      case "key_missing":
        if (link !== null) {
          addTo(missingGroups, link.id, node)
        }
        break
      case "changed_in_figma":
      case "synced":
        if (link !== null) {
          addTo(linkedGroups, link.id, node)
          if (state === "changed_in_figma") {
            changedKeys.add(link.id)
          }
        }
        break
      case "changed_in_rerune":
        if (link !== null) {
          addTo(pullGroups, link.id, node)
        }
        break
      case "conflict":
        if (link !== null) {
          addTo(conflictGroups, link.id + "|" + nodeText(node), node)
        }
        break
    }
  }

  for (const group of createGroups.values()) {
    const first = group[0]
    const text = nodeText(first)
    const candidates = input.textMatches.get(text) ?? []
    plan.creates.push({
      ref: "c" + plan.creates.length,
      nodeIds: ids(group),
      text,
      name: input.suggestName(first),
      nameIssues: [],
      description: first.frameName ?? "",
      selected: input.scope === "selection",
      match: {
        candidates: candidates.slice(),
        decision: candidates.length === 1 ? "link" : candidates.length > 1 ? null : "create",
        linkKeyId: candidates.length === 1 ? candidates[0].id : null,
      },
      origin: { kind: "unlinked" },
    })
  }

  for (const [keyId, group] of linkedGroups) {
    const remoteText = input.remote.get(keyId)?.mainText ?? ""
    const keyName = keyNameFor(keyId, group, input.remote)
    const variants: { text: string; nodes: ScannedNode[] }[] = []
    for (const node of group) {
      const text = nodeText(node)
      const variant = variants.find((entry) => entry.text === text)
      if (variant === undefined) {
        variants.push({ text, nodes: [node] })
      } else {
        variant.nodes.push(node)
      }
    }
    if (variants.length > 1) {
      plan.divergent.push({
        keyId,
        keyName,
        remoteText,
        variants: variants.map((variant) => ({ text: variant.text, nodeIds: ids(variant.nodes), decision: null })),
      })
    } else if (changedKeys.has(keyId)) {
      plan.updates.push({ ref: "u" + keyId, keyId, keyName, nodeIds: ids(group), text: variants[0].text, expectedText: remoteText, origin: { kind: "changed" } })
    } else {
      plan.unchanged += group.length
    }
  }

  for (const group of conflictGroups.values()) {
    const keyId = group[0].link?.id ?? ""
    plan.conflicts.push({
      keyId,
      keyName: keyNameFor(keyId, group, input.remote),
      nodeIds: ids(group),
      figmaText: nodeText(group[0]),
      remoteText: input.remote.get(keyId)?.mainText ?? "",
      decision: "skip",
    })
  }

  for (const [keyId, group] of pullGroups) {
    plan.pulls.push({ keyId, keyName: keyNameFor(keyId, group, input.remote), nodeIds: writeTargets(group), remoteText: input.remote.get(keyId)?.mainText ?? "" })
  }

  for (const [keyId, group] of missingGroups) {
    plan.missing.push({ keyId, keyName: group[0].link?.k ?? "", nodeIds: ids(group), text: nodeText(group[0]), decision: "skip" })
  }

  return refreshDerived(plan, input.remote, () => false)
}

function isActiveCreate(create: PlanCreate): boolean {
  return create.selected && create.match.decision === "create"
}

export function withNameIssues(plan: PushPlan, isTaken: (name: string) => boolean): PushPlan {
  const counts = new Map<string, number>()
  for (const create of plan.creates) {
    if (isActiveCreate(create)) {
      counts.set(create.name, (counts.get(create.name) ?? 0) + 1)
    }
  }
  return {
    ...plan,
    creates: plan.creates.map((create) => ({
      ...create,
      nameIssues: keyNameIssues(create.name, {
        taken: isTaken(create.name),
        duplicateInBatch: isActiveCreate(create) && (counts.get(create.name) ?? 0) > 1,
      }),
    })),
  }
}

export function withMaxLengthViolations(plan: PushPlan, remote: Map<string, RemoteWithMaxLength>): PushPlan {
  const violations: PushPlan["maxLengthViolations"] = []
  for (const update of plan.updates) {
    const maxLength = remote.get(update.keyId)?.maxLength ?? null
    const length = utf16Length(update.text)
    if (maxLength !== null && length > maxLength) {
      violations.push({ ref: update.ref, length, maxLength })
    }
  }
  return { ...plan, maxLengthViolations: violations }
}

function refreshDerived(plan: PushPlan, remote: Map<string, RemoteWithMaxLength>, isTaken: (name: string) => boolean): PushPlan {
  return withMaxLengthViolations(withNameIssues(plan, isTaken), remote)
}

function nextCreateRef(plan: PushPlan): string {
  let max = -1
  for (const create of plan.creates) {
    const index = Number(create.ref.slice(1))
    if (isFinite(index) && index > max) {
      max = index
    }
  }
  return "c" + (max + 1)
}

function nextUpdateRef(plan: PushPlan, keyId: string): string {
  const refs = new Set(plan.updates.map((update) => update.ref))
  if (!refs.has("u" + keyId)) {
    return "u" + keyId
  }
  for (let n = 2; ; n++) {
    if (!refs.has("u" + keyId + "-" + n)) {
      return "u" + keyId + "-" + n
    }
  }
}

function sameCreateOrigin(a: CreateOrigin, b: CreateOrigin): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function sameUpdateOrigin(update: PlanUpdate, keyId: string, origin: UpdateOrigin): boolean {
  return update.keyId === keyId && JSON.stringify(update.origin) === JSON.stringify(origin)
}

function withoutCreate(plan: PushPlan, origin: CreateOrigin): PushPlan {
  return { ...plan, creates: plan.creates.filter((create) => !sameCreateOrigin(create.origin, origin)) }
}

function withoutUpdate(plan: PushPlan, keyId: string, matches: (origin: UpdateOrigin) => boolean): PushPlan {
  return { ...plan, updates: plan.updates.filter((update) => update.keyId !== keyId || !matches(update.origin)) }
}

function withCreate(plan: PushPlan, context: PlanContext, origin: CreateOrigin, nodeIds: string[], text: string, name: string): PushPlan {
  if (plan.creates.some((create) => sameCreateOrigin(create.origin, origin))) {
    return plan
  }
  const first = context.nodes.get(nodeIds[0])
  const create: PlanCreate = {
    ref: nextCreateRef(plan),
    nodeIds: nodeIds.slice(),
    text,
    name,
    nameIssues: [],
    description: first?.frameName ?? "",
    selected: true,
    match: { candidates: [], decision: "create", linkKeyId: null },
    origin,
  }
  return { ...plan, creates: [...plan.creates, create] }
}

function withUpdate(plan: PushPlan, entry: Omit<PlanUpdate, "ref">): PushPlan {
  if (plan.updates.some((update) => sameUpdateOrigin(update, entry.keyId, entry.origin))) {
    return plan
  }
  return { ...plan, updates: [...plan.updates, { ...entry, ref: nextUpdateRef(plan, entry.keyId) }] }
}

function batchNames(plan: PushPlan): Set<string> {
  return new Set(plan.creates.map((create) => create.name))
}

export function applyDecision(plan: PushPlan, decision: PlanDecision, context: PlanContext): PushPlan {
  let next = plan
  switch (decision.kind) {
    case "create-selected":
      next = { ...plan, creates: plan.creates.map((create) => (create.ref === decision.ref ? { ...create, selected: decision.selected } : create)) }
      break
    case "create-name":
      next = { ...plan, creates: plan.creates.map((create) => (create.ref === decision.ref ? { ...create, name: decision.name.trim() } : create)) }
      break
    case "create-match":
      next = {
        ...plan,
        creates: plan.creates.map((create) => {
          if (create.ref !== decision.ref) {
            return create
          }
          if (decision.decision === "create") {
            return { ...create, match: { ...create.match, decision: "create", linkKeyId: null } }
          }
          const candidates = create.match.candidates.some((candidate) => candidate.id === decision.key.id)
            ? create.match.candidates
            : [...create.match.candidates, decision.key]
          return { ...create, match: { candidates, decision: "link", linkKeyId: decision.key.id } }
        }),
      }
      break
    case "divergent":
      next = applyDivergent(plan, decision, context)
      break
    case "conflict":
      next = applyConflict(plan, decision)
      break
    case "copied":
      next = applyCopied(plan, decision, context)
      break
    case "missing":
      next = applyMissing(plan, decision, context)
      break
  }
  return refreshDerived(next, context.remote, context.isTaken)
}

function applyDivergent(plan: PushPlan, decision: Extract<PlanDecision, { kind: "divergent" }>, context: PlanContext): PushPlan {
  const entry = plan.divergent.find((item) => item.keyId === decision.keyId)
  if (entry === undefined || decision.variant < 0 || decision.variant >= entry.variants.length) {
    return plan
  }
  const variants = entry.variants.map((variant, index) => {
    if (index === decision.variant) {
      return { ...variant, decision: decision.decision }
    }
    return decision.decision === "winner" && variant.decision === "winner" ? { ...variant, decision: null } : variant
  })
  let next: PushPlan = { ...plan, divergent: plan.divergent.map((item) => (item === entry ? { ...entry, variants } : item)) }
  next = withoutUpdate(next, entry.keyId, (origin) => origin.kind === "divergent" && variants[origin.variant]?.decision !== "winner")
  variants.forEach((variant, index) => {
    if (variant.decision !== "new_key") {
      next = withoutCreate(next, { kind: "divergent", keyId: entry.keyId, variant: index })
    }
  })
  const variant = variants[decision.variant]
  if (decision.decision === "winner") {
    next = withUpdate(next, {
      keyId: entry.keyId,
      keyName: entry.keyName,
      nodeIds: variant.nodeIds,
      text: variant.text,
      expectedText: entry.remoteText,
      origin: { kind: "divergent", variant: decision.variant },
    })
  } else if (decision.decision === "new_key") {
    const taken = batchNames(next)
    const name = uniqueKeyName(entry.keyName, context.style, (candidate) => candidate === entry.keyName || taken.has(candidate) || context.isTaken(candidate))
    next = withCreate(next, context, { kind: "divergent", keyId: entry.keyId, variant: decision.variant }, variant.nodeIds, variant.text, name)
  }
  return next
}

function applyConflict(plan: PushPlan, decision: Extract<PlanDecision, { kind: "conflict" }>): PushPlan {
  const entry = plan.conflicts.find((item) => item.keyId === decision.keyId && item.figmaText === decision.figmaText)
  if (entry === undefined) {
    return plan
  }
  const origin: UpdateOrigin = { kind: "conflict", figmaText: entry.figmaText }
  let next: PushPlan = {
    ...plan,
    conflicts: plan.conflicts.map((item) => (item === entry ? { ...entry, decision: decision.decision } : item)),
  }
  next = withoutUpdate(next, entry.keyId, (candidate) => candidate.kind === "conflict" && candidate.figmaText === entry.figmaText)
  if (decision.decision === "overwrite") {
    next = withUpdate(next, { keyId: entry.keyId, keyName: entry.keyName, nodeIds: entry.nodeIds, text: entry.figmaText, expectedText: entry.remoteText, origin })
  }
  return next
}

function applyCopied(plan: PushPlan, decision: Extract<PlanDecision, { kind: "copied" }>, context: PlanContext): PushPlan {
  const entry = plan.copied.find((item) => item.nodeId === decision.nodeId)
  const node = context.nodes.get(decision.nodeId)
  if (entry === undefined || node === undefined) {
    return plan
  }
  const origin: CreateOrigin = { kind: "copied", nodeId: entry.nodeId }
  let next: PushPlan = {
    ...plan,
    copied: plan.copied.map((item) => (item === entry ? { ...entry, decision: decision.decision } : item)),
  }
  next = withoutCreate(next, origin)
  if (decision.decision === "new_key") {
    next = withCreate(next, context, origin, [entry.nodeId], nodeText(node), context.suggestName(node))
  }
  return next
}

function applyMissing(plan: PushPlan, decision: Extract<PlanDecision, { kind: "missing" }>, context: PlanContext): PushPlan {
  const entry = plan.missing.find((item) => item.keyId === decision.keyId)
  if (entry === undefined) {
    return plan
  }
  const origin: CreateOrigin = { kind: "missing", keyId: entry.keyId }
  let next: PushPlan = {
    ...plan,
    missing: plan.missing.map((item) => (item === entry ? { ...entry, decision: decision.decision } : item)),
  }
  next = withoutCreate(next, origin)
  if (decision.decision === "recreate") {
    next = withCreate(next, context, origin, entry.nodeIds, entry.text, entry.keyName)
  }
  return next
}

export function canPush(plan: PushPlan): boolean {
  return plan.blockedByPreview.length === 0
}

export function planToRequests(plan: PushPlan): PushRequestChunk[] {
  if (!canPush(plan)) {
    return []
  }
  const blocked = new Set(plan.maxLengthViolations.map((violation) => violation.ref))
  const entries: { item: PushItemWire; nodeIds: string[] }[] = []
  for (const create of plan.creates) {
    if (isActiveCreate(create) && create.nameIssues.length === 0 && create.text !== "") {
      entries.push({
        item: { client_ref: create.ref, op: "create", key: create.name, text: create.text, description: create.description.trim(), max_length: null },
        nodeIds: create.nodeIds,
      })
    }
  }
  for (const update of plan.updates) {
    if (!blocked.has(update.ref) && update.text !== "") {
      entries.push({
        item: { client_ref: update.ref, op: "update", key_id: update.keyId, text: update.text, expected_text: update.expectedText },
        nodeIds: update.nodeIds,
      })
    }
  }
  const chunks: PushRequestChunk[] = []
  for (let start = 0; start < entries.length; start += PUSH_CHUNK_SIZE) {
    const slice = entries.slice(start, start + PUSH_CHUNK_SIZE)
    chunks.push({
      items: slice.map((entry) => entry.item),
      nodeIdsByRef: new Map(slice.map((entry) => [entry.item.client_ref, entry.nodeIds.slice()])),
    })
  }
  return chunks
}

export function planLinkApplies(plan: PushPlan, context: Pick<PlanContext, "projectId" | "nodes">): LinkApplyItem[] {
  const items: LinkApplyItem[] = []
  for (const create of plan.creates) {
    if (!create.selected || create.match.decision !== "link" || create.match.linkKeyId === null) {
      continue
    }
    const key = create.match.candidates.find((candidate) => candidate.id === create.match.linkKeyId)
    if (key === undefined) {
      continue
    }
    for (const nodeId of create.nodeIds) {
      items.push({ nodeId, keyId: key.id, keyName: key.key, projectId: context.projectId, src: src(create.text) })
    }
  }
  for (const entry of plan.copied) {
    const link = context.nodes.get(entry.nodeId)?.link
    if (entry.decision === "keep" && link !== null && link !== undefined) {
      items.push({ nodeId: entry.nodeId, keyId: entry.keyId, keyName: entry.keyName, projectId: context.projectId, src: link.src })
    }
  }
  return items
}

function textApplyItems(nodes: readonly ScannedNode[], text: string): TextApplyItem[] {
  return writeTargets(nodes).map((nodeId) => ({ nodeId, text, src: src(text) }))
}

function nodesOf(nodeIds: readonly string[], nodes: Map<string, ScannedNode>): ScannedNode[] {
  const result: ScannedNode[] = []
  for (const nodeId of nodeIds) {
    const node = nodes.get(nodeId)
    if (node !== undefined) {
      result.push(node)
    }
  }
  return result
}

export function planTextApplies(plan: PushPlan, context: Pick<PlanContext, "nodes">): TextApplyItem[] {
  const items: TextApplyItem[] = []
  for (const conflict of plan.conflicts) {
    if (conflict.decision === "take_rerune") {
      items.push(...textApplyItems(nodesOf(conflict.nodeIds, context.nodes), conflict.remoteText))
    }
  }
  return items
}

export function planPullApplies(plan: PushPlan): TextApplyItem[] {
  const items: TextApplyItem[] = []
  for (const pull of plan.pulls) {
    for (const nodeId of pull.nodeIds) {
      items.push({ nodeId, text: pull.remoteText, src: src(pull.remoteText) })
    }
  }
  return items
}

export function planUnlinks(plan: PushPlan): string[] {
  const nodeIds: string[] = []
  for (const entry of plan.missing) {
    if (entry.decision === "unlink") {
      nodeIds.push(...entry.nodeIds)
    }
  }
  return nodeIds
}

export function pushFollowUp(input: { projectId: string; chunk: PushRequestChunk; results: FigmaPushResult[]; nodes: Map<string, ScannedNode> }): PushFollowUp {
  const followUp: PushFollowUp = { linkApplies: [], mainComponentLinkApplies: [], conflicts: [], failures: [], quotaExceeded: false }
  const items = new Map(input.chunk.items.map((item) => [item.client_ref, item]))
  const mains = new Map<string, string>()
  for (const result of input.results) {
    const item = items.get(result.client_ref)
    const nodeIds = input.chunk.nodeIdsByRef.get(result.client_ref) ?? []
    if (item === undefined) {
      continue
    }
    const text = item.text
    if (result.status === "created" && result.key_id !== null && result.key !== null) {
      for (const nodeId of nodeIds) {
        followUp.linkApplies.push({ nodeId, keyId: result.key_id, keyName: result.key, projectId: input.projectId, src: src(text) })
      }
    } else if ((result.status === "updated" || result.status === "unchanged") && result.key_id !== null) {
      const keyName = result.key ?? (item.op === "create" ? item.key : "")
      for (const node of nodesOf(nodeIds, input.nodes)) {
        const entry = { keyId: result.key_id, keyName, projectId: input.projectId, src: src(text) }
        if (node.linkState === "ok") {
          followUp.linkApplies.push({ nodeId: node.nodeId, ...entry })
        } else if (node.linkState === "inherited" && node.link !== null && !mains.has(node.link.nid)) {
          // One representative sublayer per main: main redirects the write to the local main component's node
          // (checking it carries its own link to this key) or reports remote_component, never writing the sublayer.
          mains.set(node.link.nid, node.nodeId)
          followUp.mainComponentLinkApplies.push({ nodeId: node.nodeId, ...entry })
        }
      }
    } else if (result.status === "conflict") {
      followUp.conflicts.push({
        ref: result.client_ref,
        keyId: result.key_id ?? (item.op === "update" ? item.key_id : ""),
        keyName: result.key ?? "",
        nodeIds,
        text,
        currentText: result.current_text ?? "",
      })
    } else {
      if (result.reason === "quota_exceeded") {
        followUp.quotaExceeded = true
      }
      followUp.failures.push({
        ref: result.client_ref,
        reason: result.reason,
        message: failureMessage(result),
        keyId: result.key_id,
        keyName: result.key,
        nodeIds,
      })
    }
  }
  const direct = new Set(followUp.linkApplies.map((item) => item.nodeId))
  const redirected = new Set([...mains].filter(([nid]) => direct.has(nid)).map(([, nodeId]) => nodeId))
  followUp.mainComponentLinkApplies = followUp.mainComponentLinkApplies.filter((item) => !redirected.has(item.nodeId))
  return followUp
}

export function failureMessage(result: Pick<FigmaPushResult, "reason" | "message">, maxLength: number | null = null): string {
  if (result.reason === "invalid_text" && result.message !== null && result.message !== "") {
    return result.message
  }
  if (result.reason === "max_length_exceeded") {
    return maxLength === null ? "Longer than the key's max length." : PUSH_REASON_MESSAGES.max_length_exceeded.replace("{max}", String(maxLength))
  }
  if (result.reason !== null && Object.prototype.hasOwnProperty.call(PUSH_REASON_MESSAGES, result.reason)) {
    return PUSH_REASON_MESSAGES[result.reason]
  }
  return PUSH_REASON_MESSAGES.internal_error
}
