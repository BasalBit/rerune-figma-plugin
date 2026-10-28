import { Button, SearchTextbox, SegmentedControl } from "@create-figma-plugin/ui"
import { h, type ComponentChildren } from "preact"
import { useEffect, useMemo, useState } from "preact/hooks"
import type { FigmaLink } from "../../shared/api-types"
import type { ScannedNode, Scope } from "../../shared/messages"
import { userMessage } from "../api/client"
import type { FigmaApi } from "../api/figma-api"
import type { UiBus } from "../bus"
import { CheckInput, Chip, ErrorGroups, ErrorNote, Loading, Note, plural, preview, Small, styles, TextButton } from "../components/ui"
import { ScreenBody } from "../components/screen-body"
import {
  BADGE_LABELS,
  FILTER_LABELS,
  FILTER_ORDER,
  filterCounts,
  groupByFrame,
  keepCopiedItems,
  layerRows,
  matchesFilter,
  planExactMatches,
  searchRows,
  skippedSummary,
  STATE_LABELS,
  STATE_TONES,
  unlinkableIds,
  unlinkedTexts,
  type LayerRow,
  type StateFilter,
} from "../state/layers"
import { linkSyncWarning, pageSyncSummary, rejectedWarning, unresolvedSummary, type LinkSyncer, type PageSyncResult } from "../state/link-sync"
import { groupErrors, mainsFirst, removeLinksBatched, runBatched, type ErrorGroup } from "../state/ops"
import { fetchTextMatches } from "../state/remote"
import type { Workspace, WorkspaceState } from "../state/workspace"

// Layers (§7.8): scope, scan, list grouped by frame with state chips, filters, bulk actions and badges. Phase 2:
// link changes are synced with ReRune, and "Sync links on this page" compares ReRune's links of the page with the
// layers (§7.15).

export interface LayersScreenProps {
  notices: ComponentChildren               // the workspace notices, shown first in the scroll area (ScreenBody)
  workspace: Workspace
  state: WorkspaceState
  projectId: string
  readOnly: boolean
  api: Pick<FigmaApi, "keysByName">
  bus: UiBus
  onOpenLink(nodes: ScannedNode[]): void
  onSelect(nodeIds: string[]): void
  linkSync: LinkSyncer
  syncEnabled: boolean           // link sync is on for this file and user (§7.11)
  pageId: string
}

interface ActionResult {
  message: string
  tone: "good" | "info" | "warning"
  lists: { label: string; nodeIds: string[] }[]
  errors: ErrorGroup[]
  touched?: string[]             // layers whose links the action wrote or removed (synced with ReRune)
  syncWarning?: string | null
}

const UNRESOLVED_SHOWN = 20

const PAGE_SIZE = 200

const SCOPE_OPTIONS = [
  { value: "selection", children: "Selection" },
  { value: "page", children: "Page" },
]

export function LayersScreen(props: LayersScreenProps) {
  const { state, workspace } = props
  const [filter, setFilter] = useState<StateFilter>("all")
  const [query, setQuery] = useState("")
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [limit, setLimit] = useState(PAGE_SIZE)
  const [busy, setBusy] = useState<string | null>(null)
  const [result, setResult] = useState<ActionResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pageSync, setPageSync] = useState<PageSyncResult | null>(null)

  useEffect(() => {
    setPageSync(null)
  }, [props.pageId])

  const rows = useMemo(
    () => layerRows(state.result?.nodes ?? [], props.projectId, state.remote, state.pending),
    [state.result, state.remote, state.pending, props.projectId],
  )
  const counts = useMemo(() => filterCounts(rows), [rows])
  const visible = useMemo(() => searchRows(rows.filter((row) => matchesFilter(row, filter)), query), [rows, filter, query])
  const checkedRows = useMemo(() => rows.filter((row) => checked.has(row.node.nodeId)), [rows, checked])

  useEffect(() => {
    // Drop checks for layers that left the list after a rescan.
    setChecked((current) => new Set([...current].filter((nodeId) => rows.some((row) => row.node.nodeId === nodeId))))
  }, [rows])

  function scan(scope: Scope) {
    setResult(null)
    setError(null)
    setLimit(PAGE_SIZE)
    void workspace.scan(scope)
  }

  function toggle(nodeId: string) {
    setChecked((current) => {
      const next = new Set(current)
      if (next.has(nodeId)) {
        next.delete(nodeId)
      } else {
        next.add(nodeId)
      }
      return next
    })
  }

  function toggleAll() {
    const ids = visible.map((row) => row.node.nodeId)
    const all = ids.length > 0 && ids.every((id) => checked.has(id))
    setChecked(all ? new Set() : new Set(ids))
  }

  async function run(name: string, action: () => Promise<ActionResult | null>) {
    setBusy(name)
    setError(null)
    setResult(null)
    try {
      const outcome = await action()
      // Link sync before the rescan: both read the canvas, and the sync reads hidden instance children.
      const synced = outcome !== null && outcome.touched !== undefined && outcome.touched.length > 0
        ? await props.linkSync.syncNodes(outcome.touched, state.result?.nodes ?? [])
        : null
      setResult(outcome === null ? null : { ...outcome, syncWarning: linkSyncWarning(synced) })
      await workspace.scan()
    } catch (caught) {
      setError(userMessage(caught))
    } finally {
      setBusy(null)
    }
  }

  const linkExactMatches = () =>
    run("exact", async () => {
      const textMatches = await fetchTextMatches(props.api, props.projectId, unlinkedTexts(checkedRows))
      const plan = planExactMatches(checkedRows, textMatches, props.projectId)
      const written = await runBatched(props.bus, mainsFirst(plan.links), (requestId, batch) => ({ type: "link-apply", requestId, items: batch }))
      const lists = [
        ...plan.ambiguous.map((entry) => ({ label: "Several keys match “" + preview(entry.text, 40) + "”", nodeIds: entry.nodeIds })),
        ...(plan.unmatched.length > 0 ? [{ label: plural(plan.unmatched.reduce((sum, entry) => sum + entry.nodeIds.length, 0), "layer has", "layers have") + " no exact match", nodeIds: plan.unmatched.flatMap((entry) => entry.nodeIds) }] : []),
      ]
      return {
        message: "Linked " + plural(written.done, "layer", "layers") + " to keys with the same text." + (plan.skipped > 0 ? " " + plural(plan.skipped, "selected layer was", "selected layers were") + " already linked." : ""),
        tone: written.done > 0 ? "good" : "info",
        lists,
        errors: groupErrors(written.errors),
        touched: plan.links.map((item) => item.nodeId),
      }
    })

  const unlink = () =>
    run("unlink", async () => {
      const ids = unlinkableIds(checkedRows)
      const written = await removeLinksBatched(props.bus, ids)
      return { message: "Unlinked " + plural(written.done, "layer", "layers") + ".", tone: "info", lists: [], errors: groupErrors(written.errors), touched: ids }
    })

  const copiedTargets = checkedRows.length > 0 ? checkedRows : rows
  const copiedItems = keepCopiedItems(copiedTargets, props.projectId)
  const keepCopied = () =>
    run("copied", async () => {
      const written = await runBatched(props.bus, copiedItems, (requestId, batch) => ({ type: "link-apply", requestId, items: batch }))
      return {
        message: "Kept " + plural(written.done, "copied link", "copied links") + ".",
        tone: "good",
        lists: [],
        errors: groupErrors(written.errors),
        touched: copiedItems.map((item) => item.nodeId),
      }
    })

  // §7.15 page link sync: a fresh page scan, then ReRune's links of this page compared with the layers.
  async function syncPage() {
    setBusy("sync")
    setError(null)
    setResult(null)
    setPageSync(null)
    setLimit(PAGE_SIZE)
    try {
      const scanned = await workspace.scan("page")
      if (scanned === null) {
        setError(workspace.store.get().error ?? "The scan didn't finish. Try again.")
        return
      }
      setPageSync(await props.linkSync.syncPage(props.pageId, scanned.nodes))
    } catch (caught) {
      setError(userMessage(caught))
    } finally {
      setBusy(null)
    }
  }

  // The explicit Remove for links whose layer is not in this file (never automatic, D43).
  async function removeUnresolved(links: readonly FigmaLink[]) {
    const nodeIds = links.map((link) => link.node_id)
    setBusy("remove")
    setError(null)
    try {
      const outcome = await props.linkSync.removeServerLinks(nodeIds)
      if (outcome !== null && outcome.error !== null) {
        setError(outcome.error)
        return
      }
      setPageSync((current) => (current === null ? current : { ...current, removed: current.removed + (outcome?.removed ?? 0), unresolved: current.unresolved.filter((link) => !nodeIds.includes(link.node_id)) }))
    } catch (caught) {
      setError(userMessage(caught))
    } finally {
      setBusy(null)
    }
  }

  const groups = groupByFrame(visible.slice(0, limit))
  const scanning = state.status === "scanning"
  const skipped = state.result !== null ? skippedSummary(state.result.skipped) : null
  const writeDisabled = props.readOnly || busy !== null || scanning

  return (
    <div style={styles.page}>
      <div style={{ padding: "8px 12px", display: "flex", flexDirection: "column", gap: "8px", borderBottom: "1px solid var(--figma-color-border)" }}>
        <div style={styles.row}>
          <div style={styles.grow}>
            <SegmentedControl value={state.scope} options={SCOPE_OPTIONS} onValueChange={(value) => scan(value as Scope)} />
          </div>
          <Button secondary loading={scanning && busy !== "sync"} disabled={scanning || busy !== null} onClick={() => scan(state.scope)}>
            Scan
          </Button>
        </div>
        {props.syncEnabled && (
          <div style={styles.row}>
            <TextButton disabled={props.readOnly || busy !== null || scanning} onClick={() => void syncPage()}>
              {busy === "sync" ? "Syncing links…" : "Sync links on this page"}
            </TextButton>
          </div>
        )}
        {rows.length > 0 && (
          <div style={styles.wrapRow}>
            {FILTER_ORDER.filter((entry) => entry === "all" || counts[entry] > 0).map((entry) => (
              <button
                key={entry}
                type="button"
                onClick={() => setFilter(entry)}
                style={{
                  border: "1px solid " + (filter === entry ? "var(--figma-color-border-brand-strong)" : "var(--figma-color-border)"),
                  background: filter === entry ? "var(--figma-color-bg-brand-tertiary)" : "transparent",
                  color: "var(--figma-color-text)",
                  borderRadius: "10px",
                  padding: "0 8px",
                  fontSize: "11px",
                  lineHeight: "18px",
                  cursor: "pointer",
                }}
              >
                {FILTER_LABELS[entry]} {counts[entry]}
              </button>
            ))}
          </div>
        )}
        {rows.length > 8 && <SearchTextbox value={query} placeholder="Search text or key" onValueInput={setQuery} />}
      </div>

      <ScreenBody notices={props.notices}>
        {props.readOnly && <Note tone="warning">This file is connected to a different ReRune server, so links can't be changed here.</Note>}
        <ErrorNote message={state.error} onRetry={() => scan(state.scope)} />
        <ErrorNote message={state.remoteError} onRetry={() => void workspace.refreshRemote()} />
        <ErrorNote message={error} />
        {scanning && <Loading label={state.progress > 0 ? "Scanning… " + state.progress + " layers" : "Scanning…"} />}
        {state.status === "idle" && (
          <Note tone="info">
            {state.scope === "selection" ? "Select frames or text layers, then scan." : "Scan this page to list its text layers."}
          </Note>
        )}
        {state.status === "ready" && rows.length === 0 && (
          <Note tone="info">{state.scope === "selection" ? "No text layers in the selection. Select frames or text, then scan again." : "No text layers on this page."}</Note>
        )}
        {state.result?.truncated === true && <Note tone="warning">Only the first 5,000 text layers are listed. Scan a smaller selection to see the rest.</Note>}
        {state.remoteStatus === "loading" && <Small muted>Loading key status from ReRune…</Small>}
        {result !== null && (
          <Note
            tone={result.tone}
            actions={result.lists.map((list) => (
              <TextButton key={list.label} onClick={() => props.onSelect(list.nodeIds)}>
                {list.label} · Select
              </TextButton>
            ))}
          >
            {result.message}
          </Note>
        )}
        {result !== null && <ErrorGroups groups={result.errors} onSelect={props.onSelect} />}
        {result !== null && result.syncWarning !== null && result.syncWarning !== undefined && <Note tone="warning">{result.syncWarning}</Note>}
        {pageSync !== null && (
          <Note tone={pageSync.error !== null ? "warning" : "good"} actions={<TextButton onClick={() => setPageSync(null)}>Dismiss</TextButton>}>
            {pageSyncSummary(pageSync)}
            {rejectedWarning(pageSync.rejected.length) !== null ? " " + rejectedWarning(pageSync.rejected.length) : ""}
          </Note>
        )}
        {pageSync !== null && pageSync.unresolved.length > 0 && (
          <UnresolvedLinks links={pageSync.unresolved} disabled={props.readOnly || busy !== null} onRemove={(links) => void removeUnresolved(links)} />
        )}

        {visible.length > 0 && (
          <div style={{ ...styles.row, margin: "8px 0 4px" }}>
            <label style={{ ...styles.row, ...styles.small, cursor: "pointer" }}>
              <CheckInput checked={visible.every((row) => checked.has(row.node.nodeId))} onChange={toggleAll} label="Select all shown" />
              Select all shown
            </label>
            <span style={{ ...styles.grow, ...styles.small, ...styles.muted, textAlign: "right" }}>{skipped ?? ""}</span>
          </div>
        )}
        {groups.map((group) => (
          <div key={group.key} style={{ marginBottom: "8px" }}>
            <div style={{ ...styles.sectionTitle, margin: "8px 0 4px" }}>{group.title}</div>
            <div style={styles.tightStack}>
              {group.rows.map((row) => (
                <LayerRowView key={row.node.nodeId} row={row} checked={checked.has(row.node.nodeId)} onToggle={() => toggle(row.node.nodeId)} onOpen={() => props.onOpenLink([row.node])} />
              ))}
            </div>
          </div>
        ))}
        {visible.length > limit && (
          <Button fullWidth secondary onClick={() => setLimit(limit + PAGE_SIZE)}>
            Show more ({visible.length - limit} left)
          </Button>
        )}
      </ScreenBody>

      {(checkedRows.length > 0 || copiedItems.length > 0) && (
        <div style={styles.footer}>
          {checkedRows.length > 0 ? (
            <div style={{ ...styles.wrapRow, width: "100%" }}>
              <span style={{ ...styles.small, fontWeight: "600" }}>{checkedRows.length} selected</span>
              <Button disabled={writeDisabled} onClick={() => props.onOpenLink(checkedRows.map((row) => row.node))}>
                Link…
              </Button>
              <Button secondary disabled={writeDisabled || unlinkedTexts(checkedRows).length === 0} loading={busy === "exact"} onClick={() => void linkExactMatches()}>
                Link exact matches
              </Button>
              <Button secondary disabled={writeDisabled || unlinkableIds(checkedRows).length === 0} loading={busy === "unlink"} onClick={() => void unlink()}>
                Unlink
              </Button>
              {copiedItems.length > 0 && (
                <Button secondary disabled={writeDisabled} loading={busy === "copied"} onClick={() => void keepCopied()}>
                  Keep copied links
                </Button>
              )}
              <TextButton onClick={() => props.onSelect(checkedRows.map((row) => row.node.nodeId))}>Select on canvas</TextButton>
              <TextButton onClick={() => setChecked(new Set())}>Clear</TextButton>
            </div>
          ) : (
            <div style={{ ...styles.row, width: "100%" }}>
              <span style={{ ...styles.grow, ...styles.small }}>{plural(copiedItems.length, "copied layer keeps", "copied layers keep")} a link from another layer.</span>
              <Button secondary disabled={writeDisabled} loading={busy === "copied"} onClick={() => void keepCopied()}>
                Keep all copied links
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function LayerRowView(props: { row: LayerRow; checked: boolean; onToggle(): void; onOpen(): void }) {
  const { row } = props
  return (
    <div style={{ ...styles.row, alignItems: "flex-start", border: "1px solid var(--figma-color-border)", borderRadius: "6px", padding: "6px 8px" }}>
      <CheckInput checked={props.checked} onChange={props.onToggle} style={{ marginTop: "2px" }} label={"Select " + row.node.name} />
      <button
        type="button"
        onClick={props.onOpen}
        style={{ ...styles.grow, background: "none", border: "none", padding: "0", textAlign: "left", cursor: "pointer", color: "var(--figma-color-text)", font: "inherit" }}
      >
        <div style={{ ...styles.clamp, fontSize: "12px" }}>{preview(row.text, 160) || "(empty)"}</div>
        <div style={{ ...styles.wrapRow, marginTop: "2px" }}>
          <Chip tone={STATE_TONES[row.state]}>{STATE_LABELS[row.state]}</Chip>
          {row.keyName !== null && <span style={{ ...styles.mono, ...styles.muted }}>{row.keyName}</span>}
          {row.pendingName !== null && <span style={{ ...styles.mono, ...styles.muted }}>→ {row.pendingName}</span>}
          {row.badges.filter((badge) => badge !== "pending").map((badge) => (
            <Chip key={badge} tone={badge === "missing_font" ? "danger" : badge === "preview" ? "info" : "neutral"}>
              {BADGE_LABELS[badge]}
            </Chip>
          ))}
          {row.overMaxLength && (
            <Chip tone="warning" title="A push holds this text back until it fits the key's max length">
              Over max length ({row.textLength}/{row.maxLength})
            </Chip>
          )}
        </div>
      </button>
    </div>
  )
}

// Links whose layer resolves to null (§7.15): listed, removed only through Remove (needs edit_keys, like every
// link sync). A branch or a copy of this file shares its node ids, so these may be valid links of another file.
function UnresolvedLinks(props: { links: readonly FigmaLink[]; disabled: boolean; onRemove(links: readonly FigmaLink[]): void }) {
  const shown = props.links.slice(0, UNRESOLVED_SHOWN)
  return (
    <Note
      tone="warning"
      actions={
        <TextButton disabled={props.disabled} onClick={() => props.onRemove(props.links)}>
          {props.links.length === 1 ? "Remove" : "Remove all " + props.links.length}
        </TextButton>
      }
    >
      <div style={styles.tightStack}>
        <span>
          {unresolvedSummary(props.links.length)}. The layers may have been deleted, or the links belong to a branch or a copy of this file.
          Remove them only if the layers are gone.
        </span>
        {shown.map((link) => (
          <div key={link.node_id} style={styles.row}>
            <span style={styles.grow}>
              <span style={styles.mono}>{link.key}</span>
              <span style={styles.muted}> · {[link.node_name, link.frame_name].filter((name) => name !== "").join(" in ") || link.node_id}</span>
            </span>
            <TextButton disabled={props.disabled} onClick={() => props.onRemove([link])}>
              Remove
            </TextButton>
          </div>
        ))}
        {props.links.length > shown.length && <span style={styles.muted}>and {props.links.length - shown.length} more</span>}
      </div>
    </Note>
  )
}
