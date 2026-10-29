import type { FigmaKeyRef, FigmaPushResult } from "../../shared/api-types"
import { CODEGEN_SOURCE_TEXT_MAX_CHARS } from "../../shared/constants"
import { src } from "../../shared/hash"
import { placeholderNames } from "../../shared/icu"
import { nameSourceOf, uniqueKeyName } from "../../shared/key-names"
import type { CodegenCacheEntry, FileSettings, LinkApplyItem, NodeError, ScannedNode, Scope, TextApplyItem } from "../../shared/messages"
import { isWarning } from "../../shared/node-errors"
import {
  applyDecision,
  buildPushPlan,
  canPush,
  failureMessage,
  nodeText,
  planLinkApplies,
  planPullApplies,
  planTextApplies,
  planToRequests,
  planUnlinks,
  pushFollowUp,
  withNameIssues,
  writeTargets,
  type PlanContext,
  type PlanCreate,
  type PlanDecision,
  type PushFollowUp,
  type PushPlan,
  type PushRequestChunk,
  type RemoteWithMaxLength,
} from "../../shared/push-plan"
import { computeSyncState, type SyncState } from "../../shared/sync-state"
import { truncateUtf16 } from "../../shared/text"
import { userMessage } from "../api/client"
import type { FigmaApi } from "../api/figma-api"
import type { UiBus } from "../bus"
import { SCAN_UNFINISHED, type LinkSyncResult } from "./link-sync"
import { styleFor, suggesterFor } from "./naming"
import { mainsFirst, removeLinksBatched, runBatched, type BatchOutcome, type ScanResult } from "./ops"
import { fetchTakenNames, fetchTextMatches, type TakenName } from "./remote"
import type { WorkspaceChange, WorkspaceState } from "./workspace"

// Push screen orchestration (§7.13): E11 text and name lookups, the plan with explicit choices from the Link
// dialog applied, and the push itself with every follow-up write. While the plan is shown it follows the workspace
// as long as it shows the plan's layers: built again from the same scan when ReRune's values change (followShown,
// keeping the designer's choices), and from a fresh scan of the plan's layers by id before a push or a pull
// (checkPlan), which stops when the plan changed (planSignature).

export interface PushInput {
  projectId: string
  scope: Scope
  nodes: ScannedNode[]
  remote: Map<string, RemoteWithMaxLength>
  sample: readonly string[]
  settings: Pick<FileSettings, "caseStyle" | "keyTemplate"> | null
  groupIdenticalTexts: boolean
  pending: ReadonlyMap<string, string>
}

export interface PreparedPush {
  plan: PushPlan
  context: PlanContext
  taken: Map<string, TakenName>
  userRefs: Set<string>
  // The E11 answers of this review (texts with their matching keys, names looked up), so a plan built again from the
  // same layers asks nothing again.
  textMatches: Map<string, FigmaKeyRef[]>
  looked: { texts: Set<string>; names: Set<string> }
}

// What a plan built again keeps from the review before: its E11 answers.
export type PushLookups = Pick<PreparedPush, "taken" | "textMatches" | "looked">

const RENAME_ROUNDS = 3

export function unlinkedGroupTexts(nodes: readonly ScannedNode[], projectId: string, remote: Map<string, RemoteWithMaxLength>): string[] {
  const texts = new Set<string>()
  for (const node of nodes) {
    const state = computeSyncState(projectId, node, node.link !== null ? remote.get(node.link.id) : undefined)
    const text = nodeText(node)
    if (state === "unlinked" && text !== "") {
      texts.add(text)
    }
  }
  return [...texts]
}

function activeCreate(create: PlanCreate): boolean {
  return create.match.decision === "create"
}

function pendingNameOf(create: PlanCreate, pending: ReadonlyMap<string, string>): string | null {
  for (const nodeId of create.nodeIds) {
    const name = pending.get(nodeId)
    if (name !== undefined) {
      return name
    }
  }
  return null
}

// Explicit "Create new key" choices from the Link dialog override the defaults (selected, create, chosen name).
export function applyPendingNames(plan: PushPlan, context: PlanContext, pending: ReadonlyMap<string, string>): { plan: PushPlan; userRefs: Set<string> } {
  const userRefs = new Set<string>()
  let next = plan
  for (const create of plan.creates) {
    const name = pendingNameOf(create, pending)
    if (name === null) {
      continue
    }
    userRefs.add(create.ref)
    next = applyDecision(next, { kind: "create-name", ref: create.ref, name }, context)
    next = applyDecision(next, { kind: "create-match", ref: create.ref, decision: "create" }, context)
    next = applyDecision(next, { kind: "create-selected", ref: create.ref, selected: true }, context)
  }
  return { plan: next, userRefs }
}

// Suggested names already taken in the project, or colliding with a name the designer chose, get the next
// free suffix of their original suggestion (§7.12 step 6); names the designer chose keep their issue so they
// can link or rename. `bases` remembers each create's first suggestion across lookup rounds.
export function renameTakenSuggestions(
  plan: PushPlan,
  context: PlanContext,
  userRefs: ReadonlySet<string>,
  bases: Map<string, string> = new Map(),
): { plan: PushPlan; renamed: string[] } {
  const renamed: string[] = []
  const used = new Set(plan.creates.filter((create) => userRefs.has(create.ref)).map((create) => create.name))
  let next = plan
  for (const create of plan.creates) {
    if (userRefs.has(create.ref) || !activeCreate(create)) {
      used.add(create.name)
      continue
    }
    const clash = (name: string) => context.isTaken(name) || used.has(name)
    if (clash(create.name)) {
      const base = bases.get(create.ref) ?? create.name
      bases.set(create.ref, base)
      const name = uniqueKeyName(base, context.style, clash)
      next = applyDecision(next, { kind: "create-name", ref: create.ref, name }, context)
      renamed.push(name)
      used.add(name)
    } else {
      used.add(create.name)
    }
  }
  return { plan: next, renamed }
}

// `previous`: the review the plan is built again from; texts and names it looked up are not asked again. Its `taken`
// and `looked` are shared with the new plan (answers are only ever added), so a name lookup still running for the plan
// before reaches the new one too.
export async function preparePush(api: Pick<FigmaApi, "keysByName">, input: PushInput, previous: PushLookups | null = null): Promise<PreparedPush> {
  const suggester = suggesterFor(input.sample, input.settings)
  const sample = new Set(input.sample)
  const taken = previous?.taken ?? new Map<string, TakenName>()
  const looked = previous?.looked ?? { texts: new Set<string>(), names: new Set<string>() }
  const nodes = new Map(input.nodes.map((node) => [node.nodeId, node]))
  const suggestName = (node: ScannedNode) => suggester.suggest(nameSourceOf(node))
  const context: PlanContext = {
    projectId: input.projectId,
    nodes,
    remote: input.remote,
    style: styleFor(input.settings, input.sample),
    isTaken: (name) => sample.has(name) || taken.has(name),
    suggestName,
  }
  const texts = unlinkedGroupTexts(input.nodes, input.projectId, input.remote)
  const unknownTexts = texts.filter((text) => !looked.texts.has(text))
  const textMatches = new Map<string, FigmaKeyRef[]>()
  for (const text of texts) {
    const known = previous?.textMatches.get(text)
    if (known !== undefined && looked.texts.has(text)) {
      textMatches.set(text, known)
    }
  }
  for (const [text, keys] of await fetchTextMatches(api, input.projectId, unknownTexts)) {
    textMatches.set(text, keys)
  }
  for (const text of unknownTexts) {
    looked.texts.add(text)
  }
  let plan = buildPushPlan({
    projectId: input.projectId,
    scope: input.scope,
    nodes: input.nodes,
    remote: input.remote,
    textMatches,
    groupIdenticalTexts: input.groupIdenticalTexts,
    suggestName,
  })
  const pendingApplied = applyPendingNames(plan, context, input.pending)
  plan = pendingApplied.plan
  const bases = new Map<string, string>()
  let toCheck = plan.creates.map((create) => create.name)
  for (let round = 0; round < RENAME_ROUNDS && toCheck.length > 0; round++) {
    const unknown = toCheck.filter((name) => !looked.names.has(name.trim()))
    if (unknown.length > 0) {
      for (const [name, key] of await fetchTakenNames(api, input.projectId, unknown)) {
        taken.set(name, key)
      }
      for (const name of unknown) {
        looked.names.add(name.trim())
      }
    }
    const result = renameTakenSuggestions(plan, context, pendingApplied.userRefs, bases)
    plan = result.plan
    toCheck = result.renamed
  }
  return { plan: withNameIssues(plan, context.isTaken), context, taken, userRefs: pendingApplied.userRefs, textMatches, looked }
}

// After the designer edits a name: look it up (E11). The answers go into `taken`, which every later state of the
// same review shares, so the caller refreshes the issues on its latest plan with withCheckedNames; rebuilding
// from the plan of the keystroke would undo decisions made while the lookup ran.
export async function lookUpNames(api: Pick<FigmaApi, "keysByName">, prepared: Pick<PreparedPush, "taken" | "context">, names: readonly string[]): Promise<void> {
  const unknown = names.filter((name) => name.trim() !== "" && !prepared.taken.has(name))
  if (unknown.length > 0) {
    for (const [name, key] of await fetchTakenNames(api, prepared.context.projectId, unknown)) {
      prepared.taken.set(name, key)
    }
  }
}

export function withCheckedNames(prepared: PreparedPush): PreparedPush {
  return { ...prepared, plan: withNameIssues(prepared.plan, prepared.context.isTaken) }
}

// Entries indexed by what makes them the same entry, so carrying the choices stays linear on large plans.
function indexBy<T>(entries: readonly T[], key: (entry: T) => string): Map<string, T> {
  return new Map(entries.map((entry) => [key(entry), entry]))
}

const divergentKey = (entry: PushPlan["divergent"][number]) =>
  JSON.stringify([entry.keyId, entry.remoteText, entry.variants.map((variant) => [variant.text, variant.nodeIds])])
const conflictKey = (entry: PushPlan["conflicts"][number]) => JSON.stringify([entry.keyId, entry.figmaText, entry.remoteText, entry.nodeIds])
const missingKey = (entry: PushPlan["missing"][number]) => JSON.stringify([entry.keyId, entry.nodeIds, entry.text])
const createKey = (entry: PlanCreate) => JSON.stringify([entry.origin, entry.nodeIds, entry.text])

// The designer's choices on a plan, carried to the plan built again (`next`), on the entries that are still the same:
// the same layers with the same texts, in Figma and in ReRune. An entry that changed starts again from its default
// (a conflict whose ReRune text changed is skipped again, so a push never overwrites a text nobody saw).
export function carryDecisions(previous: PushPlan, next: PreparedPush): PreparedPush {
  const { context } = next
  let plan = next.plan
  const apply = (decision: PlanDecision) => {
    plan = applyDecision(plan, decision, context)
  }
  const divergent = indexBy(previous.divergent, divergentKey)
  for (const entry of plan.divergent) {
    divergent.get(divergentKey(entry))?.variants.forEach((variant, index) => {
      if (variant.decision !== null) {
        apply({ kind: "divergent", keyId: entry.keyId, variant: index, decision: variant.decision })
      }
    })
  }
  const conflicts = indexBy(previous.conflicts, conflictKey)
  for (const entry of plan.conflicts) {
    const before = conflicts.get(conflictKey(entry))
    if (before !== undefined && before.decision !== entry.decision) {
      apply({ kind: "conflict", keyId: entry.keyId, figmaText: entry.figmaText, decision: before.decision })
    }
  }
  const copied = indexBy(previous.copied, (entry) => entry.nodeId + "\n" + entry.keyId)
  for (const entry of plan.copied) {
    const before = copied.get(entry.nodeId + "\n" + entry.keyId)
    if (before !== undefined && before.decision !== null) {
      apply({ kind: "copied", nodeId: entry.nodeId, decision: before.decision })
    }
  }
  const missing = indexBy(previous.missing, missingKey)
  for (const entry of plan.missing) {
    const before = missing.get(missingKey(entry))
    if (before !== undefined && before.decision !== entry.decision) {
      apply({ kind: "missing", keyId: entry.keyId, decision: before.decision })
    }
  }
  // Creates last: the ones made by the choices above exist now too.
  const creates = indexBy(previous.creates, createKey)
  for (const create of plan.creates) {
    const before = creates.get(createKey(create))
    if (before === undefined) {
      continue
    }
    if (before.name !== create.name) {
      apply({ kind: "create-name", ref: create.ref, name: before.name })
    }
    if (before.match.decision === "link" && before.match.linkKeyId !== create.match.linkKeyId) {
      const key = create.match.candidates.find((candidate) => candidate.id === before.match.linkKeyId)
      if (key !== undefined) {
        apply({ kind: "create-match", ref: create.ref, decision: "link", key })
      }
    } else if (before.match.decision === "create" && create.match.decision !== "create") {
      apply({ kind: "create-match", ref: create.ref, decision: "create" })
    }
    if (before.selected !== create.selected) {
      apply({ kind: "create-selected", ref: create.ref, selected: before.selected })
    }
  }
  return { ...next, plan: withNameIssues(plan, context.isTaken) }
}

// The plan built again from the workspace as it is now (same or newer scan), with the review's E11 answers and the
// designer's choices.
export async function replanPush(api: Pick<FigmaApi, "keysByName">, previous: PreparedPush, input: PushInput): Promise<PreparedPush> {
  return carryDecisions(previous.plan, await preparePush(api, input, previous))
}

// Two plans that list the same work and the same choices have the same signature, whatever the order of their entries
// or the refs that number them.
export function planSignature(plan: PushPlan): string {
  const strip = (value: unknown) => JSON.stringify(value, (key, entry: unknown) => (key === "ref" ? undefined : entry))
  const list = (entries: readonly unknown[]) => entries.map(strip).sort()
  return JSON.stringify({
    creates: list(plan.creates),
    updates: list(plan.updates),
    divergent: list(plan.divergent),
    conflicts: list(plan.conflicts),
    pulls: list(plan.pulls),
    copied: list(plan.copied),
    missing: list(plan.missing),
    counts: [plan.unchanged, plan.readonly, plan.otherProject, plan.invalid, plan.unknown],
    blockedByPreview: [...plan.blockedByPreview].sort(),
    maxLengthViolations: list(plan.maxLengthViolations),
  })
}

// A plan built again in the background (ReRune changed, or a task wrote layers) while the plan is shown: it replaces the
// shown one until the designer makes a choice; after that only when nothing they see changes, otherwise the screen
// says "ReRune has new changes" and waits for Refresh.
export function followStep(touched: boolean, shown: PushPlan, next: PushPlan): "adopt" | "note" {
  return !touched || planSignature(shown) === planSignature(next) ? "adopt" : "note"
}

// What Update layers from ReRune would write: a pull goes ahead when a fresh scan finds the same.
export function pullSignature(plan: PushPlan): string {
  return JSON.stringify({ pulls: plan.pulls.map((pull) => JSON.stringify(pull)).sort(), blocked: [...plan.blockedByPreview].sort() })
}

// The rest of the plan, besides what Update layers from ReRune writes: when it changed, the pull says so.
export function restSignature(plan: PushPlan): string {
  return planSignature({ ...plan, pulls: [] })
}

export const KEYS_LOADING = "The layers' state in ReRune is still loading. Try again."
export const LAYERS_CHANGED = "The layers in view changed since this review. Choose Review again."

// The workspace state a plan was built from: the scan (its number, its layers) and the keys' state.
export interface PlanBase { scanId: number; result: WorkspaceState["result"]; remote: WorkspaceState["remote"] }

export function planBase(state: Pick<WorkspaceState, "scanId" | "result" | "remote">): PlanBase {
  return { scanId: state.scanId, result: state.result, remote: state.remote }
}

// The layers a plan was built from, in scan order: a push or a pull checks these again, wherever the selection is now.
export function planLayerIds(prepared: Pick<PreparedPush, "context">): string[] {
  return [...prepared.context.nodes.keys()]
}

// The workspace shows the plan's layers: the scan the plan was built from (with ReRune's values read again and what
// actions wrote), or a scan of the same layers since. Another selection's scan (the header's Reset scans the selection
// as it is now) or a page change is not followed.
export function showsPlanLayers(state: Pick<WorkspaceState, "scanId" | "result">, prepared: Pick<PreparedPush, "context">, base: Pick<PlanBase, "scanId">): boolean {
  if (state.result === null) {
    return false
  }
  if (state.scanId === base.scanId) {
    return true
  }
  const nodes = prepared.context.nodes
  return state.result.nodes.length === nodes.size && state.result.nodes.every((node) => nodes.has(node.nodeId))
}

export interface ReplanDeps {
  api: Pick<FigmaApi, "keysByName">
  state(): WorkspaceState
  // The plan's input from the workspace state (the screen's project, settings and preferences).
  input(state: WorkspaceState): PushInput
}

// A plan built again from the workspace, or why there is none: a scan or the keys' state is loading ("waiting"),
// either failed ("error"), or the workspace shows other layers than the plan's ("other").
export type Replanned = { kind: "ready"; prepared: PreparedPush; base: PlanBase } | { kind: "waiting" } | { kind: "error"; message: string } | { kind: "other" }

// The plan built again from the workspace as it is now, with the E11 answers and choices of `from`. With `base`, only
// while the workspace shows the plan's layers; without, the caller just scanned them.
export async function replanShown(deps: ReplanDeps, from: PreparedPush, base: Pick<PlanBase, "scanId"> | null): Promise<Replanned> {
  const state = deps.state()
  if (state.status === "error") {
    return { kind: "error", message: state.error ?? SCAN_UNFINISHED }
  }
  if (state.status === "scanning" || state.remoteStatus === "loading") {
    return { kind: "waiting" }
  }
  if (state.result === null || state.status !== "ready" || (base !== null && !showsPlanLayers(state, from, base))) {
    return { kind: "other" }
  }
  const remoteError = remoteLoadError(state)
  if (remoteError !== null) {
    return { kind: "error", message: remoteError }
  }
  return { kind: "ready", prepared: await replanPush(deps.api, from, deps.input(state)), base: planBase(state) }
}

// The workspace moved on while the plan is shown (a background read, an action's outcome): the plan built again
// replaces the shown one ("adopt") until the designer makes a choice (`touched`); after that, when anything they see
// changed, the screen keeps the plan and says "ReRune has new changes" ("note", with the base it would follow). null:
// nothing to follow (other layers, or the workspace is loading).
export async function followShown(
  deps: ReplanDeps,
  from: PreparedPush,
  base: Pick<PlanBase, "scanId">,
  touched: boolean,
): Promise<{ kind: "adopt"; prepared: PreparedPush; base: PlanBase } | { kind: "note"; base: PlanBase } | null> {
  const next = await replanShown(deps, from, base)
  if (next.kind !== "ready") {
    return null
  }
  return followStep(touched, from.plan, next.prepared.plan) === "adopt" ? { kind: "adopt", prepared: next.prepared, base: next.base } : { kind: "note", base: next.base }
}

export interface PushCheckDeps extends ReplanDeps {
  // A shown scan of these layers by id, with their keys' state (workspace.scanLayers); null when it did not finish.
  scanLayers(nodeIds: readonly string[]): Promise<ScanResult | null>
}

export type PushCheck = { kind: "same" | "changed"; prepared: PreparedPush; base: PlanBase } | { kind: "error"; message: string }

// Before a push or a pull: the plan's layers scanned again by id (wherever the selection is now: Select on a row or
// typing into a layer changes it) with ReRune's state, and the plan built again with the choices made. "same" when
// `signature` (what the action acts on) did not change.
export async function checkPlan(deps: PushCheckDeps, from: PreparedPush, signature: (plan: PushPlan) => string): Promise<PushCheck> {
  const scanned = await deps.scanLayers(planLayerIds(from))
  if (scanned === null) {
    return { kind: "error", message: deps.state().error ?? SCAN_UNFINISHED }
  }
  const next = await replanShown(deps, from, null)
  if (next.kind === "waiting") {
    return { kind: "error", message: KEYS_LOADING }
  }
  if (next.kind === "other") {
    return { kind: "error", message: SCAN_UNFINISHED }
  }
  if (next.kind === "error") {
    return next
  }
  return { kind: signature(next.prepared.plan) === signature(from.plan) ? "same" : "changed", prepared: next.prepared, base: next.base }
}

// The state the listed layers show now in the workspace (the Push screen's chips): null when none of them is in the
// shown scan or they differ.
export function liveState(nodeIds: readonly string[], state: Pick<WorkspaceState, "result" | "remote">, projectId: string): SyncState | null {
  const nodes = new Map((state.result?.nodes ?? []).map((node) => [node.nodeId, node]))
  let common: SyncState | null = null
  for (const nodeId of nodeIds) {
    const node = nodes.get(nodeId)
    if (node === undefined) {
      continue
    }
    const sync = computeSyncState(projectId, node, node.link === null ? undefined : state.remote.get(node.link.id))
    if (common !== null && common !== sync) {
      return null
    }
    common = sync
  }
  return common
}

// The layers a write group changed: those of `nodeIds` without an error of their own (warnings aside).
function withoutErrors(nodeIds: readonly string[], errors: readonly NodeError[]): string[] {
  const failed = new Set(errors.filter((error) => !isWarning(error)).map((error) => error.nodeId))
  return nodeIds.filter((nodeId) => !failed.has(nodeId))
}

// Update layers from ReRune as the workspace should show it at once: the layers written show the key's text, and
// their links its src.
export function pullChanges(plan: PushPlan, run: Pick<PullRun, "affectedNodeIds">): WorkspaceChange {
  const affected = new Set(run.affectedNodeIds)
  const layers: WorkspaceChange["layers"][number][] = []
  for (const pull of plan.pulls) {
    for (const nodeId of pull.groupNodeIds) {
      if (affected.has(nodeId)) {
        layers.push({ nodeId, text: pull.remoteText, src: src(pull.remoteText) })
      }
    }
  }
  return { layers }
}

type PushConflict = PushFollowUp["conflicts"][number]

// A conflict the push reported, with ReRune's newest text of the key as the workspace knows it (the background reads,
// and a read of the key just before Overwrite or Take ReRune text): the card shows it, and both act on it.
export function currentConflict(conflict: PushConflict, remote: ReadonlyMap<string, RemoteWithMaxLength>): PushConflict {
  const text = remote.get(conflict.keyId)?.found === true ? remote.get(conflict.keyId)?.mainText ?? null : null
  return text === null || text === conflict.currentText ? conflict : { ...conflict, currentText: text }
}

export const CHANGED_SINCE_PUSH = "This layer changed in Figma since the push, so ReRune was left as it is. Choose Review again."

// Before Overwrite: every layer of the conflict still shows the text the push sent (a scan of them by id). A layer
// that was edited, deleted or hidden since stops it.
export function unchangedSincePush(conflict: Pick<PushConflict, "nodeIds" | "text">, scanned: Pick<ScanResult, "nodes">): boolean {
  const nodes = new Map(scanned.nodes.map((node) => [node.nodeId, node]))
  const expected = src(conflict.text)
  return conflict.nodeIds.every((nodeId) => {
    const node = nodes.get(nodeId)
    return node !== undefined && src(nodeText(node)) === expected
  })
}

// Take ReRune text on a conflict the push reported: its layers show ReRune's current text.
export function takeReRuneChanges(conflict: PushFollowUp["conflicts"][number], run: Pick<TakeReRuneRun, "affectedNodeIds">): WorkspaceChange {
  const affected = new Set(run.affectedNodeIds)
  return {
    layers: conflict.nodeIds.filter((nodeId) => affected.has(nodeId)).map((nodeId) => ({ nodeId, text: conflict.currentText, src: src(conflict.currentText) })),
    mainTexts: new Map([[conflict.keyId, conflict.currentText]]),
  }
}

// Overwrite: when ReRune took the text, the key's text is the layer's and the links written carry its src; when it
// changed again meanwhile, the key shows its newest text.
export function overwriteChanges(conflict: PushFollowUp["conflicts"][number], run: Pick<PushRun, "updated" | "unchanged" | "conflicts" | "linkedNodeIds" | "writeErrors">): WorkspaceChange {
  if (run.updated + run.unchanged > 0) {
    return {
      layers: withoutErrors(run.linkedNodeIds, run.writeErrors).map((nodeId) => ({ nodeId, src: src(conflict.text) })),
      mainTexts: new Map([[conflict.keyId, conflict.text]]),
    }
  }
  const again = run.conflicts.find((entry) => entry.keyId === conflict.keyId)
  return { layers: [], mainTexts: again === undefined ? new Map() : new Map([[conflict.keyId, again.currentText]]) }
}

// The plan needs the remote state (E12) of every linked layer in scope (§7.10). When it failed to load, linked
// layers would read "unknown" and silently drop out of the plan, so the review stops with the error instead.
export function remoteLoadError(state: { remoteStatus: string; remoteError: string | null }): string | null {
  if (state.remoteStatus !== "error") {
    return null
  }
  return state.remoteError ?? "The layers' state in ReRune couldn't be loaded. Try again."
}

export type PushSummary = { tone: "good" | "warning"; message: string } | null

// "Everything matches" only when every layer in scope has a status; layers without one are never reported as
// in sync.
export function pushSummary(plan: PushPlan): PushSummary {
  if (plan.unknown > 0) {
    return { tone: "warning", message: (plan.unknown === 1 ? "1 linked layer has" : plan.unknown + " linked layers have") + " no status from ReRune yet. Review again." }
  }
  const total = plan.creates.length + plan.updates.length + plan.divergent.length + plan.conflicts.length + plan.copied.length + plan.missing.length + plan.pulls.length
  return total === 0 ? { tone: "good", message: "Everything in scope matches ReRune. Nothing to push." } : null
}

export interface PushCounts {
  creates: number
  links: number
  updates: number
  blockedUpdates: number
  takeReRune: number
  keepCopied: number
  unlinks: number
  pulls: number
  needsDecision: number
  nameIssues: number
}

export function pushCounts(plan: PushPlan): PushCounts {
  const blocked = new Set(plan.maxLengthViolations.map((violation) => violation.ref))
  const creates = plan.creates.filter((create) => create.selected && create.match.decision === "create")
  return {
    creates: creates.filter((create) => create.nameIssues.length === 0 && create.text !== "").length,
    links: plan.creates.filter((create) => create.selected && create.match.decision === "link").length,
    updates: plan.updates.filter((update) => !blocked.has(update.ref)).length,
    blockedUpdates: blocked.size,
    takeReRune: plan.conflicts.filter((conflict) => conflict.decision === "take_rerune").length,
    keepCopied: plan.copied.filter((entry) => entry.decision === "keep").length,
    unlinks: plan.missing.filter((entry) => entry.decision === "unlink").length,
    pulls: plan.pulls.length,
    needsDecision:
      plan.creates.filter((create) => create.selected && create.match.decision === null).length +
      plan.divergent.filter((entry) => !entry.variants.some((variant) => variant.decision !== null)).length +
      plan.copied.filter((entry) => entry.decision === null).length,
    nameIssues: creates.filter((create) => create.nameIssues.length > 0).length,
  }
}

export function hasWork(counts: PushCounts): boolean {
  return counts.creates + counts.links + counts.updates + counts.takeReRune + counts.keepCopied + counts.unlinks > 0
}

export function canSubmit(plan: PushPlan, editKeys: boolean): boolean {
  return canPush(plan) && editKeys && hasWork(pushCounts(plan))
}

export interface PushDeps {
  api: Pick<FigmaApi, "push">
  bus: Pick<UiBus, "request" | "send">
  // E13 file_key (Phase 2): the confirmed main file's key records the file's last push; null otherwise.
  fileKey?: string | null
  // Link sync for every layer the push affected (§7.13 rule 11); null when it is off.
  syncLinks?: (nodeIds: readonly string[]) => Promise<LinkSyncResult | null>
}

export interface PushRun {
  created: number
  updated: number
  unchanged: number
  linked: number
  textsApplied: number
  unlinked: number
  conflicts: PushFollowUp["conflicts"]
  failures: PushFollowUp["failures"]
  quotaExceeded: boolean
  availableKeys: number | null
  writeErrors: NodeError[]
  requestError: string | null
  cacheEntries: CodegenCacheEntry[]
  linkedNodeIds: string[]          // layers whose links the push wrote or removed (main component nodes included)
  linkSync: LinkSyncResult | null
  // Layers the push changed in ReRune or in Figma: pushed (created, updated or unchanged), linked, unlinked or given
  // ReRune's text, plus every layer in linkedNodeIds. All of them are link-synced, and their top frames get
  // screenshots (§7.13 rule 11).
  affectedNodeIds: string[]
}

export interface ConflictResolution {
  updated?: number
  conflicts?: PushFollowUp["conflicts"]
  failures?: PushFollowUp["failures"]
  writeErrors?: NodeError[]
  linkSync?: LinkSyncResult | null
}

// Merges one resolved post-push conflict into the latest run (functional update): each result must land on the
// run as it is now, not on the run its click started from. The resolved card stays where it is (its chip shows the
// layers' state now); an Overwrite that met a newer ReRune text again replaces it with the new conflict.
export function resolveConflictInRun(run: PushRun, ref: string, result: ConflictResolution): PushRun {
  const again = result.conflicts ?? []
  return {
    ...run,
    updated: run.updated + (result.updated ?? 0),
    conflicts: run.conflicts.flatMap((entry) => (entry.ref !== ref ? [entry] : again.length > 0 ? again : [entry])),
    failures: run.failures.concat(result.failures ?? []),
    writeErrors: run.writeErrors.concat(result.writeErrors ?? []),
    linkSync: mergeLinkSync(run.linkSync, result.linkSync ?? null),
  }
}

// Two link syncs of one push screen (the push, then an Overwrite) as one result for the results' warning.
export function mergeLinkSync(first: LinkSyncResult | null, second: LinkSyncResult | null): LinkSyncResult | null {
  if (first === null || second === null) {
    return first ?? second
  }
  return {
    upserted: first.upserted + second.upserted,
    removed: first.removed + second.removed,
    rejected: first.rejected.concat(second.rejected),
    error: second.error ?? first.error,
  }
}

export function emptyRun(): PushRun {
  return {
    created: 0,
    updated: 0,
    unchanged: 0,
    linked: 0,
    textsApplied: 0,
    unlinked: 0,
    conflicts: [],
    failures: [],
    quotaExceeded: false,
    availableKeys: null,
    writeErrors: [],
    requestError: null,
    cacheEntries: [],
    linkedNodeIds: [],
    linkSync: null,
    affectedNodeIds: [],
  }
}

function linkApply(deps: Pick<PushDeps, "bus">, items: readonly LinkApplyItem[]): Promise<BatchOutcome> {
  return runBatched(deps.bus, mainsFirst(items), (requestId, batch) => ({ type: "link-apply", requestId, items: batch }))
}

function textApply(deps: Pick<PushDeps, "bus">, items: readonly TextApplyItem[]): Promise<BatchOutcome> {
  return runBatched(deps.bus, mainsFirst(items), (requestId, batch) => ({ type: "text-apply", requestId, items: batch }))
}

// Codegen snippets pass the placeholders as positional arguments in ReRune order (§7.17). A created key got them
// from its text, in text order (D9). An update cannot add or reorder them (D9: `{{name}}` must exist on the key), so
// an updated or unchanged key keeps the ones E12 reported, whatever order or subset the pushed text uses. Without
// them the entry is not sent and the cached one (from an E12 load) stays.
export function cacheEntry(result: FigmaPushResult, text: string, remote: ReadonlyMap<string, Pick<RemoteWithMaxLength, "placeholders">>): CodegenCacheEntry | null {
  if (result.key_id === null || result.key === null) {
    return null
  }
  const placeholders = result.status === "created" ? placeholderNames(text) : remote.get(result.key_id)?.placeholders
  if (placeholders === undefined) {
    return null
  }
  return { keyId: result.key_id, k: result.key, placeholders: placeholders.slice(), sourceText: truncateUtf16(text, CODEGEN_SOURCE_TEXT_MAX_CHARS) }
}

// Sends push chunks one by one (never retried) and writes every follow-up link (§7.13 rule 10).
export async function pushChunks(deps: PushDeps, chunks: readonly PushRequestChunk[], context: PlanContext, run: PushRun = emptyRun()): Promise<PushRun> {
  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index]
    let response
    try {
      response = await deps.api.push(context.projectId, { file_key: deps.fileKey ?? null, items: chunk.items })
    } catch (error) {
      run.requestError = userMessage(error)
      for (const rest of chunks.slice(index)) {
        for (const item of rest.items) {
          run.failures.push({
            ref: item.client_ref,
            reason: null,
            message: run.requestError,
            keyId: item.op === "update" ? item.key_id : null,
            keyName: item.op === "create" ? item.key : null,
            nodeIds: rest.nodeIdsByRef.get(item.client_ref) ?? [],
          })
        }
      }
      break
    }
    const followUp = pushFollowUp({ projectId: context.projectId, chunk, results: response.results, nodes: context.nodes })
    const followUpLinks = [...followUp.linkApplies, ...followUp.mainComponentLinkApplies]
    const writes = await linkApply(deps, followUpLinks)
    run.writeErrors.push(...writes.errors)
    run.linkedNodeIds.push(...followUpLinks.map((item) => item.nodeId), ...mainNodeIds(followUp.mainComponentLinkApplies, context.nodes))
    run.created += response.summary.created
    run.updated += response.summary.updated
    run.unchanged += response.summary.unchanged
    run.conflicts.push(...followUp.conflicts)
    run.failures.push(
      ...followUp.failures.map((failure) => {
        const maxLength = failure.reason === "max_length_exceeded" && failure.keyId !== null ? context.remote.get(failure.keyId)?.maxLength ?? null : null
        return maxLength === null ? failure : { ...failure, message: failureMessage({ reason: failure.reason, message: null }, maxLength) }
      }),
    )
    run.quotaExceeded = run.quotaExceeded || followUp.quotaExceeded
    if (response.available_keys !== null) {
      run.availableKeys = response.available_keys
    }
    const texts = new Map(chunk.items.map((item) => [item.client_ref, item.text]))
    for (const result of response.results) {
      if (result.status === "created" || result.status === "updated" || result.status === "unchanged") {
        run.affectedNodeIds.push(...(chunk.nodeIdsByRef.get(result.client_ref) ?? []))
        const entry = cacheEntry(result, texts.get(result.client_ref) ?? "", context.remote)
        if (entry !== null) {
          run.cacheEntries.push(entry)
        }
      }
    }
  }
  return run
}

// The whole push (§7.13): link decisions and kept copies, unlinks, "Take ReRune text", then the E13 chunks.
export async function executePush(deps: PushDeps, plan: PushPlan, context: PlanContext): Promise<PushRun> {
  const run = emptyRun()
  if (!canPush(plan)) {
    return run
  }
  const linkItems = planLinkApplies(plan, context)
  const links = await linkApply(deps, linkItems)
  run.linked = links.done
  run.writeErrors.push(...links.errors)
  run.linkedNodeIds.push(...linkItems.map((item) => item.nodeId))
  const unlinks = planUnlinks(plan)
  if (unlinks.length > 0) {
    const removed = await removeLinksBatched(deps.bus, unlinks)
    run.unlinked = removed.done
    run.writeErrors.push(...removed.errors)
    run.linkedNodeIds.push(...unlinks)
  }
  const texts = await textApply(deps, planTextApplies(plan, context))
  run.textsApplied = texts.done
  run.writeErrors.push(...texts.errors)
  run.affectedNodeIds.push(...run.linkedNodeIds, ...takeReRuneNodeIds(plan))
  await pushChunks(deps, planToRequests(plan), context, run)
  return finishPush(deps, run, context)
}

// The end of every push (§7.13 rules 10 and 11): the codegen cache, then link sync for every affected layer.
// `affectedNodeIds` gains the layers whose links were written (main component nodes included), so the sync covers
// the pushed layers that show a key without a write of their own (instance text that inherits it) too.
async function finishPush(deps: PushDeps, run: PushRun, context: Pick<PlanContext, "projectId">): Promise<PushRun> {
  sendCache(deps, context.projectId, run.cacheEntries)
  run.affectedNodeIds = [...new Set([...run.affectedNodeIds, ...run.linkedNodeIds])]
  run.linkSync = await syncPushedLinks(deps, run.affectedNodeIds)
  return run
}

function takeReRuneNodeIds(plan: PushPlan): string[] {
  return plan.conflicts.filter((conflict) => conflict.decision === "take_rerune").flatMap((conflict) => conflict.nodeIds)
}

// A refresh of an inherited instance layer is written on its local main component's node (§7.6, D44): that node's
// link changes, and every instance layer that inherits from it follows (the link sync finds them by the main's id).
function mainNodeIds(items: readonly LinkApplyItem[], nodes: Map<string, ScannedNode>): string[] {
  const ids: string[] = []
  for (const item of items) {
    const link = nodes.get(item.nodeId)?.link
    if (link !== null && link !== undefined && link.nid !== item.nodeId) {
      ids.push(link.nid)
    }
  }
  return ids
}

// Phase 2 after-push link sync (§7.13 rule 11). Each layer is checked once; a failure is reported on the run and
// never fails the push.
export async function syncPushedLinks(deps: Pick<PushDeps, "syncLinks">, nodeIds: readonly string[]): Promise<LinkSyncResult | null> {
  if (deps.syncLinks === undefined || nodeIds.length === 0) {
    return null
  }
  try {
    return await deps.syncLinks([...new Set(nodeIds)])
  } catch (error) {
    return { upserted: 0, removed: 0, rejected: [], error: userMessage(error) }
  }
}

export function sendCache(deps: Pick<PushDeps, "bus">, projectId: string, entries: readonly CodegenCacheEntry[]): void {
  if (entries.length > 0) {
    deps.bus.send({ type: "cache-save", projectId, entries: entries.slice() })
  }
}

// Conflict choices after a push (§7.13 rule 10): Overwrite sends one update against the current text.
export function overwriteChunk(conflict: PushFollowUp["conflicts"][number]): PushRequestChunk {
  return {
    items: [{ client_ref: conflict.ref, op: "update", key_id: conflict.keyId, text: conflict.text, expected_text: conflict.currentText }],
    nodeIdsByRef: new Map([[conflict.ref, conflict.nodeIds.slice()]]),
  }
}

// Overwrite is a push of its own: the update with its follow-up links, the codegen cache and the link sync of the
// affected layers (§7.13 rules 10 and 11). The caller uploads the screenshots of `affectedNodeIds`.
export async function executeOverwrite(deps: PushDeps, conflict: PushFollowUp["conflicts"][number], context: PlanContext): Promise<PushRun> {
  const run = await pushChunks(deps, [overwriteChunk(conflict)], context)
  return finishPush(deps, run, context)
}

// A layer edited in Figma since the push (it no longer shows the text the push sent) is left alone (changed_meanwhile).
export function takeReRuneItems(conflict: PushFollowUp["conflicts"][number], nodes: Map<string, ScannedNode>): TextApplyItem[] {
  const targets = conflict.nodeIds.map((nodeId) => nodes.get(nodeId)).filter((node): node is ScannedNode => node !== undefined)
  return writeTargets(targets).map((nodeId) => ({ nodeId, text: conflict.currentText, src: src(conflict.currentText), expectedSrc: src(conflict.text) }))
}

export interface TakeReRuneRun {
  errors: NodeError[]
  linkSync: LinkSyncResult | null
  // Layers that now show ReRune's text (and the local main component nodes written for inherited ones).
  affectedNodeIds: string[]
}

// "Take ReRune text" on a conflict the push reported (§7.13 rules 10 and 11). As in the plan (executePush), the
// layers given ReRune's text count as affected: they are link-synced, and the caller uploads the screenshots of
// their frames. A layer whose write failed, or whose main component's write failed, changed nothing and is left out.
export async function executeTakeReRune(deps: PushDeps, conflict: PushFollowUp["conflicts"][number], context: Pick<PlanContext, "nodes">): Promise<TakeReRuneRun> {
  const written = await textApply(deps, takeReRuneItems(conflict, context.nodes))
  const affectedNodeIds = writtenLayers(conflict.nodeIds, written.errors, context.nodes)
  return { errors: written.errors, linkSync: await syncPushedLinks(deps, affectedNodeIds), affectedNodeIds }
}

// The layers of a text-apply (all of them, not only the write targets) that now show the new text: those whose
// write group (the main component node for an inherited layer, the layer itself otherwise) had no write error,
// warnings aside, plus the local main component nodes written for inherited ones. Layers not scanned are left out.
function writtenLayers(nodeIds: readonly string[], errors: readonly NodeError[], nodes: Map<string, ScannedNode>): string[] {
  const writeGroup = (node: ScannedNode) => (node.linkState === "inherited" && node.link !== null ? node.link.nid : node.nodeId)
  const failed = new Set<string>()
  for (const error of errors) {
    if (!isWarning(error)) {
      const node = nodes.get(error.nodeId)
      failed.add(node === undefined ? error.nodeId : writeGroup(node))
    }
  }
  const affected = new Set<string>()
  for (const nodeId of nodeIds) {
    const node = nodes.get(nodeId)
    if (node === undefined || failed.has(writeGroup(node))) {
      continue
    }
    affected.add(nodeId)
    // An inherited layer's text is written on its local main component's node (§7.13 rule 5).
    if (node.linkState === "inherited" && node.link !== null) {
      affected.add(node.link.nid)
    }
  }
  return [...affected]
}

// Pulls wait for previews to be reset, like the push (§7.13 rules 1 and 5, §7.14 pull): a layer that previews
// shows another language, and a pull into its main component would leave the layer's stored original stale.
export function canPull(plan: PushPlan): boolean {
  return plan.pulls.length > 0 && canPush(plan)
}

export interface PullRun extends BatchOutcome {
  // Layers that now show ReRune's text (and the local main component nodes written for inherited ones), for the
  // screenshots of their frames (SF1).
  affectedNodeIds: string[]
}

// "Update layers from ReRune" (§7.13 rule 5): text-apply, then refresh the cached key name where it changed
// (text-apply keeps `k`). Layers whose write failed keep their link untouched. The caller uploads the screenshots of
// `affectedNodeIds` (SF1). Update screenshots writes its pulls the same way (SF6).
export async function executePulls(deps: Pick<PushDeps, "bus">, plan: PushPlan, context: Pick<PlanContext, "projectId" | "nodes">): Promise<PullRun> {
  if (!canPull(plan)) {
    return { done: 0, errors: [], affectedNodeIds: [] }
  }
  const written = await textApply(deps, planPullApplies(plan, context.nodes))
  const affectedNodeIds = writtenLayers(plan.pulls.flatMap((pull) => pull.groupNodeIds), written.errors, context.nodes)
  const failed = new Set(written.errors.filter((error) => !isWarning(error)).map((error) => error.nodeId))
  const refresh: LinkApplyItem[] = []
  for (const pull of plan.pulls) {
    for (const nodeId of pull.nodeIds) {
      const link = context.nodes.get(nodeId)?.link
      if (!failed.has(nodeId) && link !== null && link !== undefined && pull.keyName !== "" && link.k !== pull.keyName) {
        refresh.push({ nodeId, keyId: pull.keyId, keyName: pull.keyName, projectId: context.projectId, src: src(pull.remoteText) })
      }
    }
  }
  if (refresh.length > 0) {
    const refreshed = await linkApply(deps, refresh)
    written.errors.push(...refreshed.errors)
  }
  return { ...written, affectedNodeIds }
}
