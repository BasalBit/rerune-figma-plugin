import { Button, SegmentedControl, Textbox } from "@create-figma-plugin/ui"
import { h, type ComponentChildren } from "preact"
import { useEffect, useRef, useState } from "preact/hooks"
import type { FigmaKeyRef, FigmaProjectDetail } from "../../shared/api-types"
import { keyNameWarnings } from "../../shared/key-names"
import type { FileSettings, ScannedNode, Scope } from "../../shared/messages"
import { applyDecision, blockedUpdateNodeIds, maxLengthCheck, type PlanCreate, type PlanDecision, type PushFollowUp, type PushPlan } from "../../shared/push-plan"
import { userMessage } from "../api/client"
import type { FigmaApi } from "../api/figma-api"
import type { UiBus } from "../bus"
import { KeyTag, KeyTags } from "../brand/key-tag"
import { CheckInput, Chip, Choice, ErrorGroups, ErrorNote, Loading, Note, plural, preview, SectionTitle, Small, styles, TextButton } from "../components/ui"
import { ScreenBody } from "../components/screen-body"
import { ScreenshotStatus, type ShotsState } from "../components/screenshot-status"
import { STATE_LABELS, STATE_TONES } from "../state/layers"
import { linkSyncWarning, SCAN_UNFINISHED, type LinkSyncResult } from "../state/link-sync"
import { groupErrors } from "../state/ops"
import {
  canPull,
  canSubmit,
  CHANGED_SINCE_PUSH,
  checkPlan,
  currentConflict,
  executeOverwrite,
  executePulls,
  executePush,
  executeTakeReRune,
  followShown,
  includedCreates,
  KEYS_LOADING,
  LAYERS_CHANGED,
  liveState,
  lookUpNames,
  overQuota,
  overwriteChanges,
  planBase,
  planLayerIds,
  planSignature,
  preparePush,
  pullChanges,
  pullSignature,
  pushCounts,
  pushSummary,
  remoteLoadError,
  replanShown,
  resolveConflictInRun,
  restSignature,
  takeReRuneChanges,
  unchangedSincePush,
  withCheckedNames,
  type PlanBase,
  type PreparedPush,
  type PullRun,
  type PushCheck,
  type PushCheckDeps,
  type PushInput,
  type PushRun,
} from "../state/push"
import { affectedFrames, emptyScreenshotRun, screenshotFreshness, type ScreenshotFrame, type ScreenshotUploader } from "../state/screenshots"
import type { Prefs } from "../state/settings"
import type { Workspace, WorkspaceState } from "../state/workspace"

// Push (§7.13): the diff with decisions, max_length warnings, the quota line, Push, and the results with the
// follow-up choices (conflicts, duplicate names, quota). After a push (and after Update layers from ReRune, SF1),
// screenshots of the changed frames are uploaded when that is on and allowed (§7.13 rule 11, §7.16); the push or
// pull stays locked until they are done or stopped. The plan follows the workspace while it shows the plan's layers:
// when ReRune's values change (the background read, without a scan) it is built again from the same scan, keeping the
// designer's choices, or, once they made one, says "ReRune has new changes" with Refresh. Push and Update layers from
// ReRune scan the plan's layers again by id (wherever the selection is now) and compare first, and stop with the new
// plan when it changed. What an action wrote shows at once in the workspace (and so in the chips here and on Layers),
// and its keys are read again.

export interface PushScreenProps {
  notices: ComponentChildren               // the workspace notices, shown first in the scroll area (ScreenBody)
  workspace: Workspace
  state: WorkspaceState
  project: FigmaProjectDetail
  settings: FileSettings | null
  prefs: Prefs
  readOnly: boolean
  api: Pick<FigmaApi, "keysByName" | "push">
  bus: UiBus
  dashboardBase: string
  onOpenLink(nodes: ScannedNode[], key: FigmaKeyRef | null): void
  onSelect(nodeIds: string[]): void
  onOpenExternal(url: string): void
  resetting: boolean
  onResetPreviews(scope: Scope, nodeIds: string[]): Promise<void>
  onAvailableKeys(availableKeys: number): void
  // A push or pull starts (true) or ends (false); the app keeps the Push tab open meanwhile.
  onBusy(busy: boolean): void
  // Another canvas task holds the work lock (Update screenshots, started from the notices): review, push, pull and
  // the follow-up choices wait for it.
  locked: boolean
  // Phase 2: E13 file_key of the confirmed main file (or null) and the after-push link sync (§7.13 rule 11).
  fileKey: string | null
  syncLinks(nodeIds: readonly string[]): Promise<LinkSyncResult | null>
  // Phase 2 screenshots on push; null leaves them out.
  screenshots: ScreenshotUploader | null
}

type Phase = "preparing" | "plan" | "pushing" | "results"
type ConflictChoice = "skip" | "overwrite" | "take_rerune"

const NAME_RECHECK_MS = 400

export const REMOTE_CHANGED_NOTE = "ReRune has new changes."
export const CHANGED_BEFORE_PUSH = "The layers or ReRune changed since this review. Check the list, then push again."
export const CHANGED_BEFORE_PULL = "ReRune or the layers changed since this review. Check the list, then update again."
export const OTHER_ROWS_CHANGED = "Other rows changed since this review. Check them before you push."

const SCOPE_OPTIONS = [
  { value: "selection", children: "Selection" },
  { value: "page", children: "Page" },
]

export function PushScreen(props: PushScreenProps) {
  const [phase, setPhase] = useState<Phase>("preparing")
  const [prepared, setPrepared] = useState<PreparedPush | null>(null)
  const [run, setRun] = useState<PushRun | null>(null)
  const [pulled, setPulled] = useState<PullRun | null>(null)
  const [pulling, setPulling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [resolved, setResolved] = useState<Record<string, { choice: ConflictChoice; done: boolean }>>({})
  const [shots, setShots] = useState<ShotsState | null>(null)
  const [stopping, setStopping] = useState(false)
  const [running, setRunning] = useState(false)
  // The designer made a choice in the plan: ReRune's changes wait for Refresh (`stale`) instead of moving the rows.
  const [touched, setTouched] = useState(false)
  const [stale, setStale] = useState(false)
  // A push or pull found the plan changed when it checked again (and stopped), or could not check; Refresh could not
  // build the plan again. A note, not an error: its choices stay, and Review again is the user's call.
  const [planNote, setPlanNote] = useState<string | null>(null)
  const busyRef = useRef(false)
  const stopShots = useRef(false)
  const nameTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const baseRef = useRef<PlanBase>({ scanId: -1, result: null, remote: new Map() })
  const staleRef = useRef<PlanBase | null>(null)
  const preparedRef = useRef(prepared)
  preparedRef.current = prepared
  const phaseRef = useRef(phase)
  phaseRef.current = phase
  const touchedRef = useRef(touched)
  touchedRef.current = touched
  const editKeys = props.project.permissions.includes("edit_keys")
  const busy = running || props.locked

  // One push, pull or conflict resolution at a time, from its first request until its screenshots are uploaded or
  // stopped: review, push and the follow-up choices wait meanwhile, and the app's lock (onBusy) is released by the
  // run that took it.
  async function exclusive(work: () => Promise<void>): Promise<void> {
    if (busyRef.current || props.locked) return
    busyRef.current = true
    setRunning(true)
    props.onBusy(true)
    try {
      await work()
    } finally {
      busyRef.current = false
      setRunning(false)
      props.onBusy(false)
    }
  }

  // The plan's input from the workspace as it is now.
  function inputOf(state: WorkspaceState): PushInput {
    return {
      projectId: props.project.id,
      scope: state.result?.scope ?? state.scope,
      nodes: state.result?.nodes ?? [],
      remote: state.remote,
      sample: props.project.key_name_sample,
      settings: props.settings,
      groupIdenticalTexts: props.prefs.groupIdenticalTexts,
      pending: state.pending,
    }
  }

  function adopt(next: PreparedPush, base: PlanBase) {
    baseRef.current = base
    staleRef.current = null
    setPrepared(next)
    setStale(false)
  }

  async function review() {
    if (busyRef.current || props.locked) return
    setPhase("preparing")
    setError(null)
    setRun(null)
    setPulled(null)
    setResolved({})
    setTouched(false)
    setStale(false)
    setPlanNote(null)
    const result = await props.workspace.scan()
    if (result === null) {
      setError(props.workspace.store.get().error ?? "The scan didn't finish. Try again.")
      setPhase("plan")
      return
    }
    const state = props.workspace.store.get()
    const remoteError = remoteLoadError(state)
    if (remoteError !== null) {
      setError(remoteError)
      setPrepared(null)
      setPhase("plan")
      return
    }
    try {
      adopt(await preparePush(props.api, inputOf(state)), planBase(state))
    } catch (caught) {
      setError(userMessage(caught))
      setPrepared(null)
    }
    setPhase("plan")
  }

  function checkDeps(): PushCheckDeps {
    return { api: props.api, state: () => props.workspace.store.get(), input: inputOf, scanLayers: (nodeIds) => props.workspace.scanLayers(nodeIds) }
  }

  // ReRune's changes (and what other tasks wrote) while the plan is shown: built again from the same scan without asking
  // anything again. Until the designer makes a choice the plan simply follows; after that, the note offers Refresh.
  useEffect(() => {
    const state = props.workspace.store.get()
    const from = prepared
    if (phase !== "plan" || from === null || busy || props.resetting || state.status !== "ready" || state.remoteStatus !== "ready") return
    const moved = (base: PlanBase | null) => base === null || base.result !== state.result || base.remote !== state.remote
    if (!moved(baseRef.current) || !moved(staleRef.current)) return
    void followShown(checkDeps(), from, baseRef.current, touchedRef.current)
      .then((next) => {
        if (next === null || preparedRef.current !== from || phaseRef.current !== "plan" || busyRef.current) return
        if (next.kind === "adopt") {
          adopt(next.prepared, next.base)
        } else {
          staleRef.current = next.base
          setStale(true)
        }
      })
      .catch(() => {})
  }, [props.state.result, props.state.remote, props.state.status, props.state.remoteStatus, phase, prepared, busy, props.resetting])

  // The plan built again with the choices made; when it can't be, a note says why and the plan stays.
  async function refresh() {
    const from = preparedRef.current
    if (from === null || busyRef.current) return
    try {
      const next = await replanShown(checkDeps(), from, baseRef.current)
      if (preparedRef.current !== from) return
      if (next.kind === "ready") {
        adopt(next.prepared, next.base)
        setPlanNote(null)
      } else {
        setPlanNote(next.kind === "waiting" ? KEYS_LOADING : next.kind === "other" ? LAYERS_CHANGED : next.message)
      }
    } catch (caught) {
      setPlanNote(userMessage(caught))
    }
  }

  // What an action wrote, in the workspace at once; then its keys are read again, quietly.
  async function showWritten(change: Parameters<Workspace["applyChanges"]>[0]) {
    const keyIds = props.workspace.applyChanges(change)
    if (keyIds.length > 0) await props.workspace.refreshKeys({ keyIds })
  }

  useEffect(() => {
    void review()
    return () => {
      if (nameTimer.current !== null) clearTimeout(nameTimer.current)
    }
  }, [])

  function decide(decision: PlanDecision) {
    if (prepared === null) return
    setTouched(true)
    setPrepared({ ...prepared, plan: applyDecision(prepared.plan, decision, prepared.context) })
  }

  function rename(ref: string, name: string) {
    if (prepared === null) return
    setTouched(true)
    const next = { ...prepared, plan: applyDecision(prepared.plan, { kind: "create-name", ref, name }, prepared.context) }
    setPrepared(next)
    if (nameTimer.current !== null) clearTimeout(nameTimer.current)
    nameTimer.current = setTimeout(() => {
      lookUpNames(props.api, next, [name.trim()])
        .then(() => setPrepared((current) => (current === null ? current : withCheckedNames(current))))
        .catch(() => {})
    }, NAME_RECHECK_MS)
  }

  async function push() {
    if (prepared === null) return
    await exclusive(async () => {
      setPhase("preparing")
      setError(null)
      setShots(null)
      setPlanNote(null)
      // A push never acts on an old scan: the plan's layers and ReRune are read again, and a plan that changed is shown
      // instead (or why it could not be checked).
      let checked: PushCheck
      try {
        checked = await checkPlan(checkDeps(), prepared, planSignature)
      } catch (caught) {
        checked = { kind: "error", message: userMessage(caught) }
      }
      if (checked.kind === "error") {
        setPlanNote(checked.message)
        setPhase("plan")
        return
      }
      if (checked.kind === "changed") {
        adopt(checked.prepared, checked.base)
        setPlanNote(CHANGED_BEFORE_PUSH)
        setPhase("plan")
        return
      }
      const fresh = checked.prepared
      adopt(fresh, checked.base)
      setPhase("pushing")
      let pushed: PushRun | null = null
      try {
        pushed = await executePush(pushDeps(), fresh.plan, fresh.context)
        setRun(pushed)
        if (pushed.availableKeys !== null) props.onAvailableKeys(pushed.availableKeys)
        // The review's layers scanned again (wherever the selection is now): Layers shows their new links and texts, the
        // results' chips their state. The rescan drops pending names of layers that are now linked; failed creates keep
        // the chosen name.
        await props.workspace.scanLayers(planLayerIds(fresh))
      } catch (caught) {
        setError(userMessage(caught))
      }
      setPhase("results")
      if (pushed !== null) {
        await uploadScreenshots(affectedFrames(pushed.affectedNodeIds, fresh.context.nodes))
      }
    })
  }

  // §7.13 rule 11: screenshots of the frames the push changed, when the gate allows (§7.16). A gate that is off
  // stays silent (the Settings screen and the file banner explain why), except when ReRune could not be asked.
  async function uploadScreenshots(frames: ScreenshotFrame[]) {
    const uploader = props.screenshots
    if (uploader === null || frames.length === 0) return
    try {
      const { gate, availability } = await uploader.prepare()
      if (!gate.enabled || gate.fileKey === null) {
        if (gate.reason === "unavailable" && availability.error !== null) {
          setShots({ kind: "unavailable", message: availability.error })
        }
        return
      }
      stopShots.current = false
      setStopping(false)
      setShots({ kind: "running", run: emptyScreenshotRun(frames.length) })
      const result = await uploader.upload(frames, {
        fileKey: gate.fileKey,
        freshness: screenshotFreshness(availability),
        stopped: () => stopShots.current,
        onProgress: (next) => setShots({ kind: "running", run: next }),
      })
      setShots({ kind: "done", run: result })
    } catch (caught) {
      setShots({ kind: "unavailable", message: userMessage(caught) })
    }
  }

  function stopScreenshots() {
    stopShots.current = true
    setStopping(true)
  }

  function pushDeps() {
    return { api: props.api, bus: props.bus, fileKey: props.fileKey, syncLinks: props.syncLinks }
  }

  // Update layers from ReRune changes the layers, so their frames get screenshots as after a push (SF1); the
  // screenshot status shows under the pull's result.
  // The pull checks the plan's layers again first, like a push, and writes only when the layers to update are still the
  // same; the rest of the plan follows the check with the choices kept (a note says when other rows changed).
  // Afterwards the plan is built again, so the updated keys leave Changed in ReRune.
  async function pull() {
    if (prepared === null) return
    await exclusive(async () => {
      setPulling(true)
      setError(null)
      setShots(null)
      setPlanNote(null)
      let done: PullRun | null = null
      let fresh: PreparedPush | null = null
      try {
        const checked = await checkPlan(checkDeps(), prepared, pullSignature)
        if (checked.kind === "error") {
          setPlanNote(checked.message)
        } else {
          adopt(checked.prepared, checked.base)
          if (checked.kind === "changed") {
            setPlanNote(CHANGED_BEFORE_PULL)
          } else {
            fresh = checked.prepared
            if (restSignature(fresh.plan) !== restSignature(prepared.plan)) setPlanNote(OTHER_ROWS_CHANGED)
            done = await executePulls({ bus: props.bus }, fresh.plan, fresh.context)
            setPulled(done)
            await showWritten(pullChanges(fresh.plan, done))
            const next = await replanShown(checkDeps(), fresh, checked.base)
            if (next.kind === "ready" && preparedRef.current === fresh) adopt(next.prepared, next.base)
          }
        }
      } catch (caught) {
        setError(userMessage(caught))
      }
      setPulling(false)
      if (done !== null && fresh !== null) {
        await uploadScreenshots(affectedFrames(done.affectedNodeIds, fresh.context.nodes))
      }
    })
  }

  async function resolveConflict(shown: PushFollowUp["conflicts"][number], choice: ConflictChoice) {
    if (prepared === null || run === null || busyRef.current || props.locked) return
    setResolved((current) => ({ ...current, [shown.ref]: { choice, done: choice === "skip" } }))
    if (choice === "skip") return
    // Each result is merged into the latest run.
    const merge = (result: Parameters<typeof resolveConflictInRun>[2]) =>
      setRun((current) => (current === null ? current : resolveConflictInRun(current, shown.ref, result)))
    // Nothing changed (or a newer conflict replaced the card): the choice can be made again.
    const reopen = () =>
      setResolved((current) => {
        const next = { ...current }
        delete next[shown.ref]
        return next
      })
    const finish = () => setResolved((current) => ({ ...current, [shown.ref]: { choice, done: true } }))
    await exclusive(async () => {
      try {
        setError(null)
        // ReRune's newest text of the key: Overwrite replaces it, Take ReRune text writes it.
        const read = await props.workspace.refreshKeys({ keyIds: [shown.keyId] })
        if (read.kind === "failed") {
          setError(userMessage(read.error))
          reopen()
          return
        }
        const conflict = currentConflict(shown, props.workspace.store.get().remote)
        if (choice === "overwrite") {
          // Overwrite sends the text the push sent: only while the layers still show it.
          const scanned = await props.workspace.scanNodes(conflict.nodeIds)
          if (scanned === null || !unchangedSincePush(conflict, scanned)) {
            setError(scanned === null ? SCAN_UNFINISHED : CHANGED_SINCE_PUSH)
            reopen()
            return
          }
          // Overwrite is a push: its layers are link-synced and their frames get screenshots (§7.13 rule 11).
          const next = await executeOverwrite(pushDeps(), conflict, prepared.context)
          merge({ updated: next.updated, conflicts: next.conflicts, failures: next.failures, writeErrors: next.writeErrors, linkSync: next.linkSync })
          if (next.conflicts.some((entry) => entry.ref === shown.ref)) reopen()
          else finish()
          // The card's chip and the Layers tab show the result at once.
          await showWritten(overwriteChanges(conflict, next))
          await uploadScreenshots(affectedFrames(next.affectedNodeIds, prepared.context.nodes))
          return
        }
        // Take ReRune text changes the layers as it does in the plan: link sync and screenshots (§7.13 rule 11). A layer
        // edited in Figma since the push is left alone.
        const taken = await executeTakeReRune(pushDeps(), conflict, prepared.context)
        merge({ writeErrors: taken.errors, linkSync: taken.linkSync })
        if (taken.affectedNodeIds.length === 0) reopen()
        else finish()
        await showWritten(takeReRuneChanges(conflict, taken))
        await uploadScreenshots(affectedFrames(taken.affectedNodeIds, prepared.context.nodes))
      } catch (caught) {
        setError(userMessage(caught))
        reopen()
      }
    })
  }

  function nodesOf(nodeIds: readonly string[]): ScannedNode[] {
    return nodeIds.map((nodeId) => prepared?.context.nodes.get(nodeId)).filter((node): node is ScannedNode => node !== undefined)
  }

  if (phase === "preparing") {
    return (
      <div style={styles.page}>
        <ScreenBody notices={props.notices}>
          <Loading label="Comparing layers with ReRune…" />
        </ScreenBody>
      </div>
    )
  }

  if (phase === "pushing") {
    return (
      <div style={styles.page}>
        <ScreenBody notices={props.notices}>
          <Loading label="Pushing drafts to ReRune…" />
        </ScreenBody>
      </div>
    )
  }

  if (phase === "results") {
    return (
      <div style={styles.page}>
        <ScreenBody notices={props.notices} stack>
          <ErrorNote message={error} />
          {run !== null && <Results run={run} props={props} resolved={resolved} busy={busy} onResolve={resolveConflict} nodesOf={nodesOf} />}
          {shots !== null && <ScreenshotStatus state={shots} stopping={stopping} onStop={stopScreenshots} onSelect={props.onSelect} />}
        </ScreenBody>
        <div style={{ ...styles.footer, justifyContent: "flex-end" }}>
          <Button disabled={busy} onClick={() => void review()}>
            Review again
          </Button>
        </div>
      </div>
    )
  }

  const plan = prepared?.plan ?? null
  const counts = plan === null ? null : pushCounts(plan)
  const submittable = plan !== null && canSubmit(plan, editKeys) && !props.readOnly
  // Update layers from ReRune shows the plan its check built from the choices made before it started, so the plan's
  // choices wait until it has written the layers. Its screenshots and another task's lock don't replace the plan.
  const choicesDisabled = pulling
  const available = props.project.available_keys
  return (
    <div style={styles.page}>
      <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--figma-color-border)" }}>
        <SegmentedControl
          value={props.state.scope}
          disabled={busy}
          options={SCOPE_OPTIONS}
          onValueChange={(value) => {
            props.workspace.setScope(value as Scope)
            void review()
          }}
        />
      </div>
      <ScreenBody notices={props.notices}>
        <ErrorNote message={error} onRetry={() => void review()} />
        {planNote !== null && <Note tone="warning">{planNote}</Note>}
        {stale && (
          <Note
            tone="rerune"
            actions={
              <TextButton disabled={busy || props.state.status === "scanning" || props.state.remoteStatus === "loading"} onClick={() => void refresh()}>
                Refresh
              </TextButton>
            }
          >
            {REMOTE_CHANGED_NOTE}
          </Note>
        )}
        {props.readOnly && <Note tone="warning">This file is connected to a different ReRune server, so nothing can be pushed from here.</Note>}
        {!editKeys && <Note tone="warning">You can view this project but not edit its keys, so you can't push. Ask an organisation administrator for the Edit keys permission.</Note>}
        {plan !== null && counts !== null && (
          <div style={styles.stack}>
            {plan.blockedByPreview.length > 0 && (
              <Note
                tone="warning"
                actions={
                  <TextButton
                    disabled={props.resetting || props.locked}
                    onClick={() =>
                      void props
                        .onResetPreviews(props.state.scope, plan.blockedByPreview)
                        .then(() => review())
                        .catch((caught: unknown) => setError(userMessage(caught)))
                    }
                  >
                    Reset previews
                  </TextButton>
                }
              >
                Reset previews before pushing. {plural(plan.blockedByPreview.length, "layer shows", "layers show")} a preview, and preview text is never pushed.
              </Note>
            )}
            <Summary plan={plan} />
            {counts.blockedUpdates > 0 && (
              <Note tone="warning" actions={<TextButton onClick={() => props.onSelect(blockedUpdateNodeIds(plan))}>Select on canvas</TextButton>}>
                {plural(counts.blockedUpdates, "change is", "changes are")} longer than the key's max length and won't be pushed. Shorten the text in Figma, or
                raise the max length in ReRune.
              </Note>
            )}
            {counts.creates > 0 && (
              <Small muted>
                {plural(counts.creates, "new key", "new keys")}
                {available !== null ? " · " + plural(available, "key", "keys") + " left on your plan" : ""}
              </Small>
            )}
            {available !== null && overQuota(counts, available) && (
              <Note tone="warning">Only {plural(available, "key is", "keys are")} left on your plan. Keys beyond the limit won't be created.</Note>
            )}
            {plan.creates.length > 0 && <NewTextHeader plan={plan} disabled={choicesDisabled} onDecide={decide} />}
            {plan.creates.map((create) => (
              <CreateCard
                key={create.ref}
                create={create}
                taken={prepared?.taken.get(create.name) ?? null}
                disabled={choicesDisabled}
                busy={busy}
                onSelect={() => props.onSelect(create.nodeIds)}
                onDecide={decide}
                onRename={(name) => rename(create.ref, name)}
                onLinkExisting={(key) => props.onOpenLink(nodesOf(create.nodeIds), key)}
              />
            ))}
            {plan.updates.length > 0 && <SectionTitle>Changed in Figma ({plan.updates.length})</SectionTitle>}
            {plan.updates.map((update) => {
              const violation = plan.maxLengthViolations.find((entry) => entry.ref === update.ref)
              return (
                <div key={update.ref} style={styles.card}>
                  <div style={styles.wrapRow}>
                    <span style={styles.grow}><KeyTag name={update.keyName} /></span>
                    {update.origin.kind === "conflict" && <Chip tone="warning">Overwrite</Chip>}
                    <TextButton onClick={() => props.onSelect(update.nodeIds)}>Select</TextButton>
                  </div>
                  <Small muted><Side>ReRune:</Side> {preview(update.expectedText, 160) || "(empty)"}</Small>
                  <Small><Side>Figma:</Side> {preview(update.text, 160)}</Small>
                  {violation !== undefined && (
                    <Small style={{ color: "var(--figma-color-text-danger)" }}>
                      Longer than the key's max length ({violation.length}/{violation.maxLength}). Shorten the text before pushing.
                    </Small>
                  )}
                </div>
              )
            })}
            {plan.divergent.length > 0 && <SectionTitle>Different texts on one key ({plan.divergent.length})</SectionTitle>}
            {plan.divergent.map((entry) => (
              <div key={entry.keyId} style={styles.card}>
                <div style={styles.wrapRow}>
                  <span style={styles.grow}><KeyTag name={entry.keyName} /></span>
                </div>
                <Small muted><Side>ReRune:</Side> {preview(entry.remoteText, 160) || "(empty)"}</Small>
                {entry.variants.map((variant, index) => (
                  <div key={index} style={styles.tightStack}>
                    <div style={styles.row}>
                      <Small style={styles.grow}>
                        {preview(variant.text, 160)} · {plural(variant.nodeIds.length, "layer", "layers")}
                      </Small>
                      <TextButton onClick={() => props.onSelect(variant.nodeIds)}>Select</TextButton>
                    </div>
                    <TooLong text={variant.text} maxLength={entry.maxLength} action="Pushing this text is blocked." />
                    <Choice
                      value={variant.decision}
                      options={[
                        { value: "winner", label: "Push this text" },
                        { value: "new_key", label: "New key" },
                        { value: "leave", label: "Leave" },
                      ]}
                      onChange={(decision) => decide({ kind: "divergent", keyId: entry.keyId, variant: index, decision })}
                      disabled={choicesDisabled}
                    />
                  </div>
                ))}
              </div>
            ))}
            {plan.conflicts.length > 0 && <SectionTitle>Changed in both ({plan.conflicts.length})</SectionTitle>}
            {plan.conflicts.map((conflict) => (
              <div key={conflict.keyId + conflict.figmaText} style={styles.card}>
                <div style={styles.wrapRow}>
                  <span style={styles.grow}><KeyTag name={conflict.keyName} /></span>
                  <TextButton onClick={() => props.onSelect(conflict.nodeIds)}>Select</TextButton>
                </div>
                <Small muted><Side>ReRune:</Side> {preview(conflict.remoteText, 160) || "(empty)"}</Small>
                <Small><Side>Figma:</Side> {preview(conflict.figmaText, 160)}</Small>
                <TooLong text={conflict.figmaText} maxLength={conflict.maxLength} action="Overwrite ReRune is blocked." />
                <Choice
                  value={conflict.decision}
                  options={[
                    { value: "skip", label: "Skip" },
                    { value: "overwrite", label: "Overwrite ReRune" },
                    { value: "take_rerune", label: "Take ReRune text" },
                  ]}
                  onChange={(decision) => decide({ kind: "conflict", keyId: conflict.keyId, figmaText: conflict.figmaText, decision })}
                  disabled={choicesDisabled}
                />
              </div>
            ))}
            {plan.copied.length > 0 && <SectionTitle>Copied layers ({plan.copied.length})</SectionTitle>}
            {plan.copied.map((entry) => (
              <div key={entry.nodeId} style={styles.card}>
                <div style={styles.wrapRow}>
                  <span style={styles.grow}><KeyTag name={entry.keyName} /></span>
                  <TextButton onClick={() => props.onSelect([entry.nodeId])}>Select</TextButton>
                </div>
                <Small muted>{preview(nodesOf([entry.nodeId])[0]?.characters ?? "", 160)}</Small>
                <Choice
                  value={entry.decision}
                  options={[
                    { value: "keep", label: "Keep link" },
                    { value: "new_key", label: "New key" },
                  ]}
                  onChange={(decision) => decide({ kind: "copied", nodeId: entry.nodeId, decision })}
                  disabled={choicesDisabled}
                />
              </div>
            ))}
            {plan.missing.length > 0 && <SectionTitle>Keys missing in ReRune ({plan.missing.length})</SectionTitle>}
            {plan.missing.map((entry) => (
              <div key={entry.keyId} style={styles.card}>
                <div style={styles.wrapRow}>
                  <span style={styles.grow}><KeyTag name={entry.keyName} /></span>
                  <TextButton onClick={() => props.onSelect(entry.nodeIds)}>Select</TextButton>
                </div>
                <Small muted>The key no longer exists. {preview(entry.text, 120)}</Small>
                <Choice
                  value={entry.decision}
                  options={[
                    { value: "skip", label: "Skip" },
                    { value: "recreate", label: "Recreate" },
                    { value: "unlink", label: "Unlink" },
                  ]}
                  onChange={(decision) => decide({ kind: "missing", keyId: entry.keyId, decision })}
                  disabled={choicesDisabled}
                />
              </div>
            ))}
            {plan.pulls.length > 0 && (
              <div>
                <SectionTitle>Changed in ReRune ({plan.pulls.length})</SectionTitle>
                <Note
                  tone="rerune"
                  actions={
                    <Button secondary disabled={busy || props.readOnly || !canPull(plan)} loading={pulling} onClick={() => void pull()}>
                      Update layers from ReRune
                    </Button>
                  }
                >
                  {plural(plan.pulls.length, "key has", "keys have")} newer text in ReRune: <KeyTags names={plan.pulls.slice(0, 3).map((entry) => entry.keyName)} />
                  {plan.pulls.length > 3 ? "…" : ""}
                  {!canPull(plan) && " Reset previews first."}
                </Note>
              </div>
            )}
            {pulled !== null && (
              <div style={styles.tightStack}>
                <Note tone="good">Updated {plural(pulled.done, "layer", "layers")} from ReRune.</Note>
                <ErrorGroups groups={groupErrors(pulled.errors)} onSelect={props.onSelect} />
                {shots !== null && <ScreenshotStatus state={shots} stopping={stopping} onStop={stopScreenshots} onSelect={props.onSelect} />}
              </div>
            )}
            <Counts plan={plan} />
          </div>
        )}
      </ScreenBody>
      <div style={styles.footer}>
        <TextButton disabled={busy} onClick={() => void review()}>
          Review again
        </TextButton>
        <div style={styles.grow} />
        {counts !== null && counts.needsDecision > 0 && <Small muted>{plural(counts.needsDecision, "item needs", "items need")} a decision</Small>}
        <Button disabled={!submittable || busy} onClick={() => void push()}>
          {counts === null ? "Push" : "Push " + plural(counts.creates + counts.updates + counts.links + counts.keepCopied + counts.takeReRune + counts.unlinks, "change", "changes")}
        </Button>
      </div>
    </div>
  )
}

// "ReRune:" / "Figma:" before the two texts of a change: which side each one is.
function Side(props: { children: string }) {
  return <span style={{ fontWeight: "600", color: "var(--figma-color-text)" }}>{props.children}</span>
}

// max_length (§7.13 rule 9, §7.18.3): the Figma text is longer than the key allows, so the update is held back.
function TooLong(props: { text: string; maxLength: number | null; action: string }) {
  const check = maxLengthCheck(props.text, props.maxLength)
  if (check === null) {
    return null
  }
  return (
    <Small style={{ color: "var(--figma-color-text-danger)" }}>
      Longer than the key's max length ({check.length}/{check.maxLength}). {props.action}
    </Small>
  )
}

function Summary(props: { plan: PushPlan }) {
  const summary = pushSummary(props.plan)
  return summary === null ? null : <Note tone={summary.tone}>{summary.message}</Note>
}

function Counts(props: { plan: PushPlan }) {
  const { plan } = props
  const parts = [
    plan.unchanged > 0 ? plural(plan.unchanged, "layer in sync", "layers in sync") : null,
    plan.readonly > 0 ? plural(plan.readonly, "read-only layer", "read-only layers") : null,
    plan.otherProject > 0 ? plural(plan.otherProject, "layer of another project", "layers of another project") : null,
    plan.invalid > 0 ? plural(plan.invalid, "broken link", "broken links") : null,
    plan.unknown > 0 ? plural(plan.unknown, "layer without status", "layers without status") : null,
  ].filter((part): part is string => part !== null)
  return parts.length === 0 ? null : <Small muted style={{ marginTop: "8px" }}>{parts.join(" · ")}</Small>
}

// The New text header with Select all, ticked when every new text is in the push and partly ticked when only some are.
// It ticks them all (from none or some) or none (from all) in one step and counts as a choice, so a background change
// then waits for Refresh. Each card keeps its Link to / Create new key choice, its name and its name issues.
export function NewTextHeader(props: { plan: Pick<PushPlan, "creates">; disabled: boolean; onDecide(decision: PlanDecision): void }) {
  const count = props.plan.creates.length
  const included = includedCreates(props.plan)
  return (
    <div style={{ ...styles.row, margin: "12px 0 6px" }}>
      <SectionTitle style={{ ...styles.grow, margin: "0" }}>New text ({count})</SectionTitle>
      <label style={{ ...styles.row, ...styles.small, gap: "6px", cursor: props.disabled ? "default" : "pointer", ...(props.disabled ? styles.muted : {}) }}>
        <CheckInput
          checked={included === "all"}
          mixed={included === "some"}
          disabled={props.disabled}
          label={"Select all new texts (" + count + ")"}
          onChange={() => props.onDecide({ kind: "creates-selected", selected: included !== "all" })}
        />
        Select all
      </label>
    </div>
  )
}

export function CreateCard(props: {
  create: PlanCreate
  taken: { id: string; key: string; type: string } | null
  // A run or a locked task (Update screenshots) is going on: the Link dialog would replace the tabs and rescan.
  busy: boolean
  // The plan's choices wait (Update layers from ReRune runs), as the header's Select all and the other sections' choices.
  disabled: boolean
  onSelect(): void
  onDecide(decision: PlanDecision): void
  onRename(name: string): void
  onLinkExisting(key: FigmaKeyRef): void
}) {
  const { create } = props
  const options = [
    ...create.match.candidates.map((candidate) => ({ value: "link:" + candidate.id, label: "Link to " + candidate.key })),
    { value: "create", label: "Create new key" },
  ]
  const current = create.match.decision === "link" ? "link:" + create.match.linkKeyId : create.match.decision === "create" ? "create" : null
  return (
    <div style={{ ...styles.card, opacity: create.selected ? "1" : "0.7" }}>
      <div style={{ ...styles.row, alignItems: "flex-start" }}>
        <CheckInput
          checked={create.selected}
          label="Include in push"
          disabled={props.disabled}
          onChange={() => props.onDecide({ kind: "create-selected", ref: create.ref, selected: !create.selected })}
          style={{ marginTop: "2px" }}
        />
        <div style={{ ...styles.grow, ...styles.clamp }}>{preview(create.text, 200)}</div>
        <TextButton onClick={props.onSelect}>{plural(create.nodeIds.length, "layer", "layers")}</TextButton>
      </div>
      {create.match.candidates.length > 0 && (
        <div style={styles.tightStack}>
          <Small muted>{create.match.candidates.length === 1 ? "The same text exists in ReRune." : "Several keys have this text. Pick one or create a new key."}</Small>
          <Choice
            value={current}
            options={options}
            disabled={props.disabled}
            onChange={(value) => {
              if (value === "create") {
                props.onDecide({ kind: "create-match", ref: create.ref, decision: "create" })
                return
              }
              const key = create.match.candidates.find((candidate) => "link:" + candidate.id === value)
              if (key !== undefined) props.onDecide({ kind: "create-match", ref: create.ref, decision: "link", key })
            }}
          />
        </div>
      )}
      {create.match.decision === "create" && (
        <div style={styles.tightStack}>
          <Textbox value={create.name} onValueInput={props.onRename} spellCheck={false} disabled={props.disabled} style={styles.keyInput} />
          {create.nameIssues.map((issue) => (
            <Small key={issue} style={{ color: "var(--figma-color-text-danger)" }}>
              {issue}
            </Small>
          ))}
          {props.taken !== null && props.taken.type === "key" && create.nameIssues.length > 0 && (
            <div>
              {/* The Link dialog compares the layer text with the key's text and asks when they differ (§7.11). */}
              <TextButton disabled={props.busy} onClick={() => props.taken !== null && props.onLinkExisting({ id: props.taken.id, key: props.taken.key })}>
                Link to existing key {props.taken.key}
              </TextButton>
            </div>
          )}
          {keyNameWarnings(create.name).map((warning) => (
            <Small key={warning} muted>
              {warning}
            </Small>
          ))}
          {create.description !== "" && <Small muted>Description: {create.description}</Small>}
        </div>
      )}
    </div>
  )
}

function Results(props: {
  run: PushRun
  props: PushScreenProps
  resolved: Record<string, { choice: ConflictChoice; done: boolean }>
  busy: boolean
  onResolve(conflict: PushFollowUp["conflicts"][number], choice: ConflictChoice): Promise<void>
  nodesOf(nodeIds: readonly string[]): ScannedNode[]
}) {
  const { run } = props
  const screen = props.props
  const done = [
    run.created > 0 ? plural(run.created, "key created", "keys created") : null,
    run.updated > 0 ? plural(run.updated, "draft updated", "drafts updated") : null,
    run.unchanged > 0 ? plural(run.unchanged, "already up to date", "already up to date") : null,
    run.linked > 0 ? plural(run.linked, "layer linked", "layers linked") : null,
    run.textsApplied > 0 ? plural(run.textsApplied, "layer updated from ReRune", "layers updated from ReRune") : null,
    run.unlinked > 0 ? plural(run.unlinked, "layer unlinked", "layers unlinked") : null,
  ].filter((part): part is string => part !== null)
  // Conflicts resolved since the push stay listed with their chip; only the open ones keep the note informative.
  const open = run.conflicts.filter((conflict) => props.resolved[conflict.ref]?.done !== true)
  // A clean run (nothing failed, no conflict left open) gets the postmark.
  const clean = run.failures.length === 0 && open.length === 0
  return (
    <div style={styles.stack}>
      <Note tone={clean ? "good" : "info"} postmark={clean}>
        {done.length > 0 ? done.join(" · ") + "." : "Nothing was changed."} Drafts are never published from Figma.
      </Note>
      {linkSyncWarning(run.linkSync) !== null && <Note tone="warning">{linkSyncWarning(run.linkSync)}</Note>}
      {run.quotaExceeded && (
        <Note tone="warning" actions={<TextButton onClick={() => screen.onOpenExternal(screen.dashboardBase + "/translator")}>Open ReRune</TextButton>}>
          Your plan's key limit is reached.
        </Note>
      )}
      {run.conflicts.length > 0 && <SectionTitle>Changed in ReRune meanwhile ({run.conflicts.length})</SectionTitle>}
      {run.conflicts.map((conflict) => {
        const state = props.resolved[conflict.ref]
        // The layers' state in the workspace now: Synced once Overwrite or Take ReRune text is done.
        const now = liveState(conflict.nodeIds, screen.state, screen.project.id)
        // ReRune's newest text of the key (read again in the background), which Overwrite and Take ReRune text act on.
        const current = currentConflict(conflict, screen.state.remote)
        return (
          <div key={conflict.ref} style={styles.card}>
            <div style={styles.wrapRow}>
              <span style={styles.grow}><KeyTag name={conflict.keyName} /></span>
              {now !== null && <Chip tone={STATE_TONES[now]}>{STATE_LABELS[now]}</Chip>}
              <TextButton onClick={() => screen.onSelect(conflict.nodeIds)}>Select</TextButton>
            </div>
            <Small muted><Side>ReRune now:</Side> {preview(current.currentText, 160) || "(empty)"}</Small>
            <Small><Side>Figma:</Side> {preview(conflict.text, 160)}</Small>
            {state?.choice === "skip" ? (
              <Small muted>Skipped.</Small>
            ) : (
              <Choice
                value={state === undefined ? null : state.choice}
                disabled={state !== undefined || props.busy}
                options={[
                  { value: "overwrite", label: "Overwrite" },
                  { value: "take_rerune", label: "Take ReRune text" },
                  { value: "skip", label: "Skip" },
                ]}
                onChange={(choice) => void props.onResolve(conflict, choice)}
              />
            )}
          </div>
        )
      })}
      {run.failures.length > 0 && <SectionTitle>Not pushed ({run.failures.length})</SectionTitle>}
      {run.failures.map((failure) => (
        <div key={failure.ref} style={styles.card}>
          <div style={styles.wrapRow}>
            {failure.keyName !== null && <span style={styles.grow}><KeyTag name={failure.keyName} /></span>}
            <TextButton onClick={() => screen.onSelect(failure.nodeIds)}>{plural(failure.nodeIds.length, "layer", "layers")}</TextButton>
          </div>
          <Small style={{ color: "var(--figma-color-text-danger)" }}>{failure.message}</Small>
          {failure.reason === "duplicate_key" && failure.keyId !== null && failure.keyName !== null && (
            <div style={styles.wrapRow}>
              <TextButton disabled={props.busy} onClick={() => screen.onOpenLink(props.nodesOf(failure.nodeIds), { id: failure.keyId ?? "", key: failure.keyName ?? "" })}>
                Link to existing {failure.keyName}
              </TextButton>
              <Small muted>or choose Review again to rename it.</Small>
            </div>
          )}
          {failure.reason === "key_not_found" && <Small muted>Choose Review again to recreate or unlink it.</Small>}
        </div>
      ))}
      <ErrorGroups groups={groupErrors(run.writeErrors)} onSelect={screen.onSelect} />
    </div>
  )
}
