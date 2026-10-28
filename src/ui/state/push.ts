import type { FigmaPushResult } from "../../shared/api-types"
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
  type PushFollowUp,
  type PushPlan,
  type PushRequestChunk,
  type RemoteWithMaxLength,
} from "../../shared/push-plan"
import { computeSyncState } from "../../shared/sync-state"
import { truncateUtf16 } from "../../shared/text"
import { userMessage } from "../api/client"
import type { FigmaApi } from "../api/figma-api"
import type { UiBus } from "../bus"
import type { LinkSyncResult } from "./link-sync"
import { styleFor, suggesterFor } from "./naming"
import { mainsFirst, removeLinksBatched, runBatched, type BatchOutcome } from "./ops"
import { fetchTakenNames, fetchTextMatches, type TakenName } from "./remote"

// Push screen orchestration (§7.13): E11 text and name lookups, the plan with explicit choices from the Link
// dialog applied, and the push itself with every follow-up write.

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
}

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

export async function preparePush(api: Pick<FigmaApi, "keysByName">, input: PushInput): Promise<PreparedPush> {
  const suggester = suggesterFor(input.sample, input.settings)
  const sample = new Set(input.sample)
  const taken = new Map<string, TakenName>()
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
  const textMatches = await fetchTextMatches(api, input.projectId, unlinkedGroupTexts(input.nodes, input.projectId, input.remote))
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
    for (const [name, key] of await fetchTakenNames(api, input.projectId, toCheck)) {
      taken.set(name, key)
    }
    const result = renameTakenSuggestions(plan, context, pendingApplied.userRefs, bases)
    plan = result.plan
    toCheck = result.renamed
  }
  return { plan: withNameIssues(plan, context.isTaken), context, taken, userRefs: pendingApplied.userRefs }
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
// run as it is now, not on the run its click started from.
export function resolveConflictInRun(run: PushRun, ref: string, result: ConflictResolution): PushRun {
  return {
    ...run,
    updated: run.updated + (result.updated ?? 0),
    conflicts: run.conflicts.filter((entry) => entry.ref !== ref).concat(result.conflicts ?? []),
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

function linkApply(deps: PushDeps, items: readonly LinkApplyItem[]): Promise<BatchOutcome> {
  return runBatched(deps.bus, mainsFirst(items), (requestId, batch) => ({ type: "link-apply", requestId, items: batch }))
}

function textApply(deps: PushDeps, items: readonly TextApplyItem[]): Promise<BatchOutcome> {
  return runBatched(deps.bus, mainsFirst(items), (requestId, batch) => ({ type: "text-apply", requestId, items: batch }))
}

function cacheEntry(result: FigmaPushResult, text: string): CodegenCacheEntry | null {
  if (result.key_id === null || result.key === null) {
    return null
  }
  return { keyId: result.key_id, k: result.key, placeholders: placeholderNames(text), sourceText: truncateUtf16(text, CODEGEN_SOURCE_TEXT_MAX_CHARS) }
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
        const entry = cacheEntry(result, texts.get(result.client_ref) ?? "")
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

export function takeReRuneItems(conflict: PushFollowUp["conflicts"][number], nodes: Map<string, ScannedNode>): TextApplyItem[] {
  const targets = conflict.nodeIds.map((nodeId) => nodes.get(nodeId)).filter((node): node is ScannedNode => node !== undefined)
  return writeTargets(targets).map((nodeId) => ({ nodeId, text: conflict.currentText, src: src(conflict.currentText) }))
}

export async function applyTakeReRune(deps: PushDeps, conflict: PushFollowUp["conflicts"][number], nodes: Map<string, ScannedNode>): Promise<BatchOutcome> {
  return textApply(deps, takeReRuneItems(conflict, nodes))
}

// Pulls wait for previews to be reset, like the push (§7.13 rules 1 and 5, §7.14 pull): a layer that previews
// shows another language, and a pull into its main component would leave the layer's stored original stale.
export function canPull(plan: PushPlan): boolean {
  return plan.pulls.length > 0 && canPush(plan)
}

// "Update layers from ReRune" (§7.13 rule 5): text-apply, then refresh the cached key name where it changed
// (text-apply keeps `k`). Layers whose write failed keep their link untouched.
export async function executePulls(deps: PushDeps, plan: PushPlan, context: PlanContext): Promise<BatchOutcome> {
  if (!canPull(plan)) {
    return { done: 0, errors: [] }
  }
  const written = await textApply(deps, planPullApplies(plan))
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
  return written
}
