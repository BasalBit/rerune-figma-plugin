import { Button, SegmentedControl, Textbox } from "@create-figma-plugin/ui"
import { h } from "preact"
import { useEffect, useRef, useState } from "preact/hooks"
import type { FigmaKeyRef, FigmaProjectDetail } from "../../shared/api-types"
import { keyNameWarnings } from "../../shared/key-names"
import type { FileSettings, ScannedNode, Scope } from "../../shared/messages"
import { applyDecision, type PlanCreate, type PlanDecision, type PushFollowUp, type PushPlan } from "../../shared/push-plan"
import { userMessage } from "../api/client"
import type { FigmaApi } from "../api/figma-api"
import type { UiBus } from "../bus"
import { CheckInput, Chip, Choice, ErrorGroups, ErrorNote, Loading, Note, plural, preview, SectionTitle, Small, styles, TextButton } from "../components/ui"
import { linkSyncWarning, type LinkSyncResult } from "../state/link-sync"
import { groupErrors, type BatchOutcome } from "../state/ops"
import {
  applyTakeReRune,
  canPull,
  canSubmit,
  executePulls,
  executePush,
  lookUpNames,
  overwriteChunk,
  preparePush,
  pushChunks,
  pushCounts,
  pushSummary,
  remoteLoadError,
  resolveConflictInRun,
  sendCache,
  withCheckedNames,
  type PreparedPush,
  type PushRun,
} from "../state/push"
import {
  affectedFrames,
  emptyScreenshotRun,
  groupProblems,
  progressText,
  screenshotSummary,
  type ScreenshotFrame,
  type ScreenshotRun,
  type ScreenshotUploader,
} from "../state/screenshots"
import type { Prefs } from "../state/settings"
import type { Workspace, WorkspaceState } from "../state/workspace"

// Push (§7.13): the diff with decisions, max_length warnings, the quota line, Push, and the results with the
// follow-up choices (conflicts, duplicate names, quota). After a push, screenshots of the changed frames are
// uploaded when that is on and allowed (§7.13 rule 11, §7.16); the push stays locked until they are done or stopped.

export interface PushScreenProps {
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
  // Phase 2: E13 file_key of the confirmed main file (or null) and the after-push link sync (§7.13 rule 11).
  fileKey: string | null
  syncLinks(nodeIds: readonly string[]): Promise<LinkSyncResult | null>
  // Phase 2 screenshots on push; null leaves them out.
  screenshots: ScreenshotUploader | null
}

type Phase = "preparing" | "plan" | "pushing" | "results"
type ShotsState = { kind: "running"; run: ScreenshotRun } | { kind: "done"; run: ScreenshotRun } | { kind: "unavailable"; message: string }
type ConflictChoice = "skip" | "overwrite" | "take_rerune"

const NAME_RECHECK_MS = 400

const SCOPE_OPTIONS = [
  { value: "selection", children: "Selection" },
  { value: "page", children: "Page" },
]

export function PushScreen(props: PushScreenProps) {
  const [phase, setPhase] = useState<Phase>("preparing")
  const [prepared, setPrepared] = useState<PreparedPush | null>(null)
  const [run, setRun] = useState<PushRun | null>(null)
  const [pulled, setPulled] = useState<BatchOutcome | null>(null)
  const [pulling, setPulling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [resolved, setResolved] = useState<Record<string, ConflictChoice | "done">>({})
  const [shots, setShots] = useState<ShotsState | null>(null)
  const [stopping, setStopping] = useState(false)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const stopShots = useRef(false)
  const nameTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const editKeys = props.project.permissions.includes("edit_keys")

  // One push, pull or conflict resolution at a time, from its first request until its screenshots are uploaded or
  // stopped: review, push and the follow-up choices wait meanwhile, and the app's lock (onBusy) is released by the
  // run that took it.
  async function exclusive(work: () => Promise<void>): Promise<void> {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    props.onBusy(true)
    try {
      await work()
    } finally {
      busyRef.current = false
      setBusy(false)
      props.onBusy(false)
    }
  }

  async function review() {
    if (busyRef.current) return
    setPhase("preparing")
    setError(null)
    setRun(null)
    setPulled(null)
    setResolved({})
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
      const next = await preparePush(props.api, {
        projectId: props.project.id,
        scope: result.scope,
        nodes: result.nodes,
        remote: state.remote,
        sample: props.project.key_name_sample,
        settings: props.settings,
        groupIdenticalTexts: props.prefs.groupIdenticalTexts,
        pending: state.pending,
      })
      setPrepared(next)
    } catch (caught) {
      setError(userMessage(caught))
      setPrepared(null)
    }
    setPhase("plan")
  }

  useEffect(() => {
    void review()
    return () => {
      if (nameTimer.current !== null) clearTimeout(nameTimer.current)
    }
  }, [])

  function decide(decision: PlanDecision) {
    if (prepared === null) return
    setPrepared({ ...prepared, plan: applyDecision(prepared.plan, decision, prepared.context) })
  }

  function rename(ref: string, name: string) {
    if (prepared === null) return
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
      setPhase("pushing")
      setError(null)
      setShots(null)
      let pushed: PushRun | null = null
      try {
        pushed = await executePush(pushDeps(), prepared.plan, prepared.context)
        setRun(pushed)
        if (pushed.availableKeys !== null) props.onAvailableKeys(pushed.availableKeys)
        // The rescan drops pending names of layers that are now linked; failed creates keep the chosen name.
        await props.workspace.scan()
      } catch (caught) {
        setError(userMessage(caught))
      }
      setPhase("results")
      if (pushed !== null) {
        await uploadScreenshots(affectedFrames(pushed.affectedNodeIds, prepared.context.nodes))
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
      const result = await uploader.upload(frames, { fileKey: gate.fileKey, stopped: () => stopShots.current, onProgress: (next) => setShots({ kind: "running", run: next }) })
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

  async function pull() {
    if (prepared === null) return
    await exclusive(async () => {
      setPulling(true)
      setError(null)
      try {
        setPulled(await executePulls({ api: props.api, bus: props.bus }, prepared.plan, prepared.context))
      } catch (caught) {
        setError(userMessage(caught))
      }
      setPulling(false)
    })
  }

  async function resolveConflict(conflict: PushFollowUp["conflicts"][number], choice: ConflictChoice) {
    if (prepared === null || run === null || busyRef.current) return
    setResolved((current) => ({ ...current, [conflict.ref]: choice }))
    if (choice === "skip") return
    // Each result is merged into the latest run.
    const merge = (result: Parameters<typeof resolveConflictInRun>[2]) =>
      setRun((current) => (current === null ? current : resolveConflictInRun(current, conflict.ref, result)))
    await exclusive(async () => {
      try {
        if (choice === "overwrite") {
          const next = await pushChunks({ api: props.api, bus: props.bus, fileKey: props.fileKey }, [overwriteChunk(conflict)], prepared.context)
          sendCache({ bus: props.bus }, props.project.id, next.cacheEntries)
          merge({ updated: next.updated, conflicts: next.conflicts, failures: next.failures, writeErrors: next.writeErrors })
        } else {
          const written = await applyTakeReRune({ api: props.api, bus: props.bus }, conflict, prepared.context.nodes)
          merge({ writeErrors: written.errors })
        }
        setResolved((current) => ({ ...current, [conflict.ref]: "done" }))
      } catch (caught) {
        setError(userMessage(caught))
        setResolved((current) => {
          const next = { ...current }
          delete next[conflict.ref]
          return next
        })
      }
    })
  }

  function nodesOf(nodeIds: readonly string[]): ScannedNode[] {
    return nodeIds.map((nodeId) => prepared?.context.nodes.get(nodeId)).filter((node): node is ScannedNode => node !== undefined)
  }

  if (phase === "preparing") {
    return (
      <div style={styles.page}>
        <div style={styles.body}>
          <Loading label="Comparing layers with ReRune…" />
        </div>
      </div>
    )
  }

  if (phase === "pushing") {
    return (
      <div style={styles.page}>
        <div style={styles.body}>
          <Loading label="Pushing drafts to ReRune…" />
        </div>
      </div>
    )
  }

  if (phase === "results") {
    return (
      <div style={styles.page}>
        <div style={{ ...styles.body, ...styles.stack }}>
          <ErrorNote message={error} />
          {run !== null && <Results run={run} props={props} resolved={resolved} busy={busy} onResolve={resolveConflict} nodesOf={nodesOf} />}
          {shots !== null && <ScreenshotStatus state={shots} stopping={stopping} onStop={stopScreenshots} onSelect={props.onSelect} />}
        </div>
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
      <div style={styles.body}>
        <ErrorNote message={error} onRetry={() => void review()} />
        {props.readOnly && <Note tone="warning">This file is connected to a different ReRune server, so nothing can be pushed from here.</Note>}
        {!editKeys && <Note tone="warning">You can view this project but not edit its keys, so you can't push. Ask a project admin for the Edit keys permission.</Note>}
        {plan !== null && counts !== null && (
          <div style={styles.stack}>
            {plan.blockedByPreview.length > 0 && (
              <Note
                tone="warning"
                actions={
                  <TextButton
                    disabled={props.resetting}
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
            {counts.creates > 0 && (
              <Small muted>
                {plural(counts.creates, "new key", "new keys")}
                {available !== null ? " · " + plural(available, "key", "keys") + " left on your plan" : ""}
              </Small>
            )}
            {available !== null && counts.creates > available && (
              <Note tone="warning">Only {plural(available, "key is", "keys are")} left on your plan. Keys beyond the limit won't be created.</Note>
            )}
            {plan.creates.length > 0 && <SectionTitle>New text ({plan.creates.length})</SectionTitle>}
            {plan.creates.map((create) => (
              <CreateCard
                key={create.ref}
                create={create}
                taken={prepared?.taken.get(create.name) ?? null}
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
                    <span style={{ ...styles.grow, ...styles.mono }}>{update.keyName}</span>
                    {update.origin.kind === "conflict" && <Chip tone="warning">Overwrite</Chip>}
                    <TextButton onClick={() => props.onSelect(update.nodeIds)}>Select</TextButton>
                  </div>
                  <Small muted>ReRune: {preview(update.expectedText, 160) || "(empty)"}</Small>
                  <Small>Figma: {preview(update.text, 160)}</Small>
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
                  <span style={{ ...styles.grow, ...styles.mono }}>{entry.keyName}</span>
                </div>
                <Small muted>ReRune: {preview(entry.remoteText, 160) || "(empty)"}</Small>
                {entry.variants.map((variant, index) => (
                  <div key={index} style={styles.tightStack}>
                    <div style={styles.row}>
                      <Small style={styles.grow}>
                        {preview(variant.text, 160)} · {plural(variant.nodeIds.length, "layer", "layers")}
                      </Small>
                      <TextButton onClick={() => props.onSelect(variant.nodeIds)}>Select</TextButton>
                    </div>
                    <Choice
                      value={variant.decision}
                      options={[
                        { value: "winner", label: "Push this text" },
                        { value: "new_key", label: "New key" },
                        { value: "leave", label: "Leave" },
                      ]}
                      onChange={(decision) => decide({ kind: "divergent", keyId: entry.keyId, variant: index, decision })}
                    />
                  </div>
                ))}
              </div>
            ))}
            {plan.conflicts.length > 0 && <SectionTitle>Changed in both ({plan.conflicts.length})</SectionTitle>}
            {plan.conflicts.map((conflict) => (
              <div key={conflict.keyId + conflict.figmaText} style={styles.card}>
                <div style={styles.wrapRow}>
                  <span style={{ ...styles.grow, ...styles.mono }}>{conflict.keyName}</span>
                  <TextButton onClick={() => props.onSelect(conflict.nodeIds)}>Select</TextButton>
                </div>
                <Small muted>ReRune: {preview(conflict.remoteText, 160) || "(empty)"}</Small>
                <Small>Figma: {preview(conflict.figmaText, 160)}</Small>
                <Choice
                  value={conflict.decision}
                  options={[
                    { value: "skip", label: "Skip" },
                    { value: "overwrite", label: "Overwrite ReRune" },
                    { value: "take_rerune", label: "Take ReRune text" },
                  ]}
                  onChange={(decision) => decide({ kind: "conflict", keyId: conflict.keyId, figmaText: conflict.figmaText, decision })}
                />
              </div>
            ))}
            {plan.copied.length > 0 && <SectionTitle>Copied layers ({plan.copied.length})</SectionTitle>}
            {plan.copied.map((entry) => (
              <div key={entry.nodeId} style={styles.card}>
                <div style={styles.wrapRow}>
                  <span style={{ ...styles.grow, ...styles.mono }}>{entry.keyName}</span>
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
                />
              </div>
            ))}
            {plan.missing.length > 0 && <SectionTitle>Keys missing in ReRune ({plan.missing.length})</SectionTitle>}
            {plan.missing.map((entry) => (
              <div key={entry.keyId} style={styles.card}>
                <div style={styles.wrapRow}>
                  <span style={{ ...styles.grow, ...styles.mono }}>{entry.keyName}</span>
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
                />
              </div>
            ))}
            {plan.pulls.length > 0 && (
              <div>
                <SectionTitle>Changed in ReRune ({plan.pulls.length})</SectionTitle>
                <Note
                  tone="info"
                  actions={
                    <Button secondary disabled={busy || props.readOnly || pulled !== null || !canPull(plan)} loading={pulling} onClick={() => void pull()}>
                      Update layers from ReRune
                    </Button>
                  }
                >
                  {plural(plan.pulls.length, "key has", "keys have")} newer text in ReRune: {plan.pulls.slice(0, 3).map((entry) => entry.keyName).join(", ")}
                  {plan.pulls.length > 3 ? "…" : ""}
                  {!canPull(plan) && " Reset previews first."}
                </Note>
                {pulled !== null && (
                  <div style={{ marginTop: "6px" }}>
                    <Note tone="good">Updated {plural(pulled.done, "layer", "layers")} from ReRune.</Note>
                    <ErrorGroups groups={groupErrors(pulled.errors)} onSelect={props.onSelect} />
                  </div>
                )}
              </div>
            )}
            <Counts plan={plan} />
          </div>
        )}
      </div>
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

// Screenshot upload after a push: progress with Stop, then the summary and the frames that weren't uploaded.
function ScreenshotStatus(props: { state: ShotsState; stopping: boolean; onStop(): void; onSelect(nodeIds: string[]): void }) {
  const { state } = props
  if (state.kind === "unavailable") {
    return <Note tone="warning">Screenshots weren't uploaded: {state.message}</Note>
  }
  if (state.kind === "running") {
    return (
      <Note
        tone="info"
        actions={
          <TextButton disabled={props.stopping} onClick={props.onStop}>
            {props.stopping ? "Stopping…" : "Stop"}
          </TextButton>
        }
      >
        {progressText(state.run)}
      </Note>
    )
  }
  const summary = screenshotSummary(state.run)
  const groups = groupProblems(state.run.problems)
  if (summary === null && groups.length === 0) {
    return null
  }
  return (
    <div style={styles.stack}>
      {summary !== null && <Note tone={summary.tone}>{summary.message}</Note>}
      {groups.length > 0 && <SectionTitle>Screenshots not uploaded ({state.run.problems.length})</SectionTitle>}
      {groups.map((group) => (
        <div key={group.message} style={styles.card}>
          <div style={styles.wrapRow}>
            <Small style={styles.grow}>{group.message}</Small>
            <TextButton onClick={() => props.onSelect(group.frameIds)}>{plural(group.frameIds.length, "frame", "frames")}</TextButton>
          </div>
          <Small muted>{group.frameNames.join(", ")}</Small>
        </div>
      ))}
    </div>
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

function CreateCard(props: {
  create: PlanCreate
  taken: { id: string; key: string; type: string } | null
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
          <Textbox value={create.name} onValueInput={props.onRename} spellCheck={false} />
          {create.nameIssues.map((issue) => (
            <Small key={issue} style={{ color: "var(--figma-color-text-danger)" }}>
              {issue}
            </Small>
          ))}
          {props.taken !== null && props.taken.type === "key" && create.nameIssues.length > 0 && (
            <div>
              {/* The Link dialog compares the layer text with the key's text and asks when they differ (§7.11). */}
              <TextButton onClick={() => props.taken !== null && props.onLinkExisting({ id: props.taken.id, key: props.taken.key })}>
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
  resolved: Record<string, ConflictChoice | "done">
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
  return (
    <div style={styles.stack}>
      <Note tone={run.failures.length === 0 && run.conflicts.length === 0 ? "good" : "info"}>
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
        return (
          <div key={conflict.ref} style={styles.card}>
            <div style={styles.wrapRow}>
              <span style={{ ...styles.grow, ...styles.mono }}>{conflict.keyName}</span>
              <TextButton onClick={() => screen.onSelect(conflict.nodeIds)}>Select</TextButton>
            </div>
            <Small muted>ReRune now: {preview(conflict.currentText, 160) || "(empty)"}</Small>
            <Small>Figma: {preview(conflict.text, 160)}</Small>
            {state === "skip" ? (
              <Small muted>Skipped.</Small>
            ) : (
              <Choice
                value={state === undefined || state === "done" ? null : state}
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
            {failure.keyName !== null && <span style={{ ...styles.grow, ...styles.mono }}>{failure.keyName}</span>}
            <TextButton onClick={() => screen.onSelect(failure.nodeIds)}>{plural(failure.nodeIds.length, "layer", "layers")}</TextButton>
          </div>
          <Small style={{ color: "var(--figma-color-text-danger)" }}>{failure.message}</Small>
          {failure.reason === "duplicate_key" && failure.keyId !== null && failure.keyName !== null && (
            <div style={styles.wrapRow}>
              <TextButton onClick={() => screen.onOpenLink(props.nodesOf(failure.nodeIds), { id: failure.keyId ?? "", key: failure.keyName ?? "" })}>
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
