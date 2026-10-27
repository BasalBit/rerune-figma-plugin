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
import { styleFor, suggesterFor } from "./naming"
import { mainsFirst, runBatched, type BatchOutcome } from "./ops"
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

// After the designer edits a name: look it up (E11) and refresh the issues.
export async function recheckNames(api: Pick<FigmaApi, "keysByName">, prepared: PreparedPush, names: readonly string[]): Promise<PreparedPush> {
  const unknown = names.filter((name) => name.trim() !== "" && !prepared.taken.has(name))
  if (unknown.length > 0) {
    for (const [name, key] of await fetchTakenNames(api, prepared.context.projectId, unknown)) {
      prepared.taken.set(name, key)
    }
  }
  return { ...prepared, plan: withNameIssues(prepared.plan, prepared.context.isTaken) }
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
      response = await deps.api.push(context.projectId, { file_key: null, items: chunk.items })
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
    const writes = await linkApply(deps, [...followUp.linkApplies, ...followUp.mainComponentLinkApplies])
    run.writeErrors.push(...writes.errors)
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
  const links = await linkApply(deps, planLinkApplies(plan, context))
  run.linked = links.done
  run.writeErrors.push(...links.errors)
  const unlinks = planUnlinks(plan)
  if (unlinks.length > 0) {
    const removed = await runBatched(deps.bus, unlinks, (requestId, batch) => ({ type: "link-remove", requestId, nodeIds: batch }))
    run.unlinked = removed.done
    run.writeErrors.push(...removed.errors)
  }
  const texts = await textApply(deps, planTextApplies(plan, context))
  run.textsApplied = texts.done
  run.writeErrors.push(...texts.errors)
  await pushChunks(deps, planToRequests(plan), context, run)
  sendCache(deps, context.projectId, run.cacheEntries)
  return run
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

export function takeReRuneItems(conflict: PushFollowUp["conflicts"][number], nodes: Map<string, ScannedNode>): TextApplyItem[] {
  const targets = conflict.nodeIds.map((nodeId) => nodes.get(nodeId)).filter((node): node is ScannedNode => node !== undefined)
  return writeTargets(targets).map((nodeId) => ({ nodeId, text: conflict.currentText, src: src(conflict.currentText) }))
}

export async function applyTakeReRune(deps: PushDeps, conflict: PushFollowUp["conflicts"][number], nodes: Map<string, ScannedNode>): Promise<BatchOutcome> {
  return textApply(deps, takeReRuneItems(conflict, nodes))
}

// "Update layers from ReRune" (§7.13 rule 5): text-apply, then refresh the cached key name where it changed
// (text-apply keeps `k`). Layers whose write failed keep their link untouched.
export async function executePulls(deps: PushDeps, plan: PushPlan, context: PlanContext): Promise<BatchOutcome> {
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
