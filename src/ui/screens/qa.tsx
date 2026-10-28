import { Button, SegmentedControl } from "@create-figma-plugin/ui"
import { h } from "preact"
import { useState } from "preact/hooks"
import type { FigmaProjectDetail } from "../../shared/api-types"
import type { Scope } from "../../shared/messages"
import { pseudoLocalize } from "../../shared/pseudo"
import { userMessage } from "../api/client"
import type { UiBus } from "../bus"
import { ErrorGroups, ErrorNote, Loading, Note, plural, SectionTitle, Small, styles } from "../components/ui"
import { groupErrors, runBatched, type ErrorGroup } from "../state/ops"
import { buildPseudoPreview, type PseudoBuild } from "../state/preview"
import type { Workspace, WorkspaceState } from "../state/workspace"

// QA (§7.8, §7.18, Design mode only). Pseudo-localization (§7.18.2, Appendix A.6) previews every text layer in scope
// with accented, longer text through preview-apply (source "pseudo"); Reset and the status bar work as for language
// previews. Sample values and plural forms are set on the Preview screen, whose language decides the categories.

export interface QaScreenProps {
  workspace: Workspace
  state: WorkspaceState
  project: FigmaProjectDetail
  readOnly: boolean
  bus: UiBus
  onSelect(nodeIds: string[]): void
  onReset(scope: Scope, nodeIds?: string[]): Promise<void>
  resetting: boolean                      // a reset started elsewhere (Nav, Push, Preview) is running
  onApplying(applying: boolean): void     // lets the app hold other resets while previews are written
}

const SCOPE_OPTIONS = [
  { value: "selection", children: "Selection" },
  { value: "page", children: "Page" },
]

export const PSEUDO_EXAMPLE = "Pay now"

interface PseudoApplied { build: PseudoBuild; done: number; errors: ErrorGroup[] }

export function QaScreen(props: QaScreenProps) {
  const [scope, setScope] = useState<Scope>(props.state.scope)
  const [busy, setBusy] = useState<"apply" | "reset" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [applied, setApplied] = useState<PseudoApplied | null>(null)

  async function applyPseudo() {
    if (props.resetting) return
    setBusy("apply")
    props.onApplying(true)
    setError(null)
    setApplied(null)
    try {
      const result = await props.workspace.scan(scope)
      if (result === null) {
        setError(props.workspace.store.get().error ?? "The scan didn't finish. Try again.")
        return
      }
      const build = buildPseudoPreview(result.nodes, props.project.main_language)
      const written = await runBatched(props.bus, build.items, (requestId, batch) => ({ type: "preview-apply", requestId, info: build.info, items: batch }))
      setApplied({ build, done: written.done, errors: groupErrors(written.errors) })
      await props.workspace.scan(scope)
    } catch (caught) {
      setError(userMessage(caught))
    } finally {
      setBusy(null)
      props.onApplying(false)
    }
  }

  async function reset() {
    setBusy("reset")
    setError(null)
    try {
      await props.onReset(scope)
      setApplied(null)
    } catch (caught) {
      setError(userMessage(caught))
    } finally {
      setBusy(null)
    }
  }

  const disabled = props.readOnly || busy !== null || props.resetting
  return (
    <div style={styles.page}>
      <div style={{ ...styles.body, ...styles.stack }}>
        {props.readOnly && <Note tone="warning">This file is connected to a different ReRune server.</Note>}
        <div style={styles.tightStack}>
          <SectionTitle>Pseudo-localization</SectionTitle>
          <Small>
            Replaces letters with accented look-alikes and makes each text about 30–40% longer, so you can spot layers that clip or
            truncate before real translations arrive. Placeholders like {"{{name}}"} stay as they are.
          </Small>
          <Small muted>
            {PSEUDO_EXAMPLE} → {pseudoLocalize(PSEUDO_EXAMPLE)}
          </Small>
          <Small muted>Every text layer in scope is changed until you reset it, linked or not. Pseudo text is never pushed.</Small>
        </div>
        <div style={styles.tightStack}>
          <Small muted>Apply to</Small>
          <SegmentedControl value={scope} options={SCOPE_OPTIONS} onValueChange={(value) => setScope(value as Scope)} />
        </div>
        <ErrorNote message={error} />
        {busy === "apply" && <Loading label="Pseudo-localizing…" />}
        {applied !== null && (
          <div style={styles.stack}>
            <Note tone="good">
              Pseudo-localized {plural(applied.done, "layer", "layers")}.
              {applied.build.skipped.variable.length > 0 ? " " + plural(applied.build.skipped.variable.length, "layer uses", "layers use") + " a Figma variable and kept its text." : ""}
            </Note>
            <ErrorGroups groups={applied.errors} onSelect={props.onSelect} />
          </div>
        )}
      </div>
      <div style={{ ...styles.footer, justifyContent: "flex-end" }}>
        <Button secondary disabled={disabled} loading={busy === "reset"} onClick={() => void reset()}>
          Reset {scope === "page" ? "page" : "selection"}
        </Button>
        <Button disabled={disabled} loading={busy === "apply"} onClick={() => void applyPseudo()}>
          Pseudo-localize {scope === "page" ? "page" : "selection"}
        </Button>
      </div>
    </div>
  )
}
