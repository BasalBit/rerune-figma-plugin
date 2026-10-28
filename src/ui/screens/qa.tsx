import { Button, Dropdown, SegmentedControl, Toggle } from "@create-figma-plugin/ui"
import { h, type ComponentChildren } from "preact"
import { useMemo, useRef, useState } from "preact/hooks"
import type { FigmaProjectDetail } from "../../shared/api-types"
import type { ResolveSource, Scope } from "../../shared/messages"
import { pseudoLocalize } from "../../shared/pseudo"
import { userMessage } from "../api/client"
import type { FigmaApi } from "../api/figma-api"
import type { UiBus } from "../bus"
import { copyText } from "../clipboard"
import { SamplesSection, usePluralShapes, useSampleDrafts } from "../components/samples"
import { CheckInput, Chip, ErrorGroups, ErrorNote, Loading, Note, plural, preview, SectionTitle, Small, styles, TextButton } from "../components/ui"
import { ScreenBody } from "../components/screen-body"
import { groupErrors, runBatched, undoStep, type ErrorGroup } from "../state/ops"
import { buildPseudoPreview, languageLabel, type PseudoBuild, type RenderChoices } from "../state/preview"
import {
  amountText,
  KEEP_OPEN_HINT,
  kindLabel,
  makeLanguageCopies,
  PSEUDO_LANGUAGE,
  QaRefusal,
  reportCsv,
  reportIssueCount,
  reportLanguageLabel,
  runOverflowReport,
  type CopiesResult,
  type LanguageReport,
  type OverflowReport,
  type QaDeps,
  type ReportKind,
} from "../state/qa"
import { activePluralChoice, projectSamples, samplePlaceholders, type ProjectPluralChoice } from "../state/samples"
import type { Prefs } from "../state/settings"
import type { WorkLock } from "../state/work-lock"
import type { Workspace, WorkspaceState } from "../state/workspace"

// QA (§7.8, §7.18, Design mode only):
// - Overflow report (§7.18.1): each picked language (and pseudo-localization) is previewed on the layers in scope,
//   measured by main (clipped, truncated, outside its frame) and checked against max length; the canvas is reset
//   when the report ends. Per-language table with Select, and Copy CSV.
// - Language copies (§7.18.4, D32): one copy per language of each top-level frame of the selection.
// - Pseudo-localization (§7.18.2, Appendix A.6) through preview-apply with source "pseudo".
// Values render with the sample values and plural form (§7.18.5), set here or on the Preview screen (the same
// saved samples and the same session plural choice).

// What the QA tab keeps while other tabs are open: the picks and the last results. `source` and `variation` start
// from the Preview screen's last choice (undefined) until changed here.
export interface QaSession {
  languages: string[]
  withPseudo: boolean
  source?: ResolveSource
  variation?: string | null
  report: OverflowReport | null
  copies: CopiesResult | null
}

export const NEW_QA_SESSION: QaSession = { languages: [], withPseudo: false, report: null, copies: null }

export interface QaScreenProps {
  notices: ComponentChildren               // the workspace notices, shown first in the scroll area (ScreenBody)
  workspace: Workspace
  state: WorkspaceState
  project: FigmaProjectDetail
  prefs: Prefs
  readOnly: boolean
  api: Pick<FigmaApi, "resolveKeys">
  bus: UiBus
  onPrefs(patch: Partial<Prefs>): void
  onSelect(nodeIds: string[]): void
  onReset(scope: Scope, nodeIds?: string[]): Promise<void>
  onReportReset(scope: Scope, nodeIds: string[]): Promise<void>  // the report's final reset: after any running reset, never merged into it
  resetting: boolean                      // a reset started elsewhere (Nav, Push, Preview) is running
  locked: boolean                         // a canvas task (one of this screen's included) holds the work lock
  // The report, the copies and pseudo-localization each hold it, so no other task writes previews meanwhile and the
  // tabs and Change project stay put.
  work: Pick<WorkLock, "acquire" | "release">
  pluralChoice: ProjectPluralChoice | null
  onPluralChoice(choice: ProjectPluralChoice | null): void
  session: QaSession
  onSession(patch: Partial<QaSession>): void
}

const SCOPE_OPTIONS = [
  { value: "selection", children: "Selection" },
  { value: "page", children: "Page" },
]

const SOURCE_OPTIONS = [
  { value: "draft", children: "Draft" },
  { value: "published", children: "Published" },
]

const NO_VARIATION = "__none__"

export const PSEUDO_EXAMPLE = "Pay now"

const KIND_TONES: Record<ReportKind, "warning" | "danger" | "info"> = { clipped: "danger", truncated: "warning", exceeds_parent: "warning", max_length: "info" }

interface PseudoApplied { build: PseudoBuild; done: number; errors: ErrorGroup[] }

type Busy = "apply" | "reset" | "report" | "copies" | null

export function QaScreen(props: QaScreenProps) {
  const { project } = props
  const [scope, setScope] = useState<Scope>(props.state.scope)
  const [busy, setBusy] = useState<Busy>(null)
  const [error, setError] = useState<string | null>(null)
  const [refusal, setRefusal] = useState<{ message: string; nodeIds: string[] } | null>(null)
  const [applied, setApplied] = useState<PseudoApplied | null>(null)
  const { session, onSession } = props
  const languages = session.languages.filter((code) => project.languages.some((language) => language.code === code))
  const source = session.source ?? props.prefs.lastSource
  const preferred = session.variation === undefined ? props.prefs.lastVariationOptionId : session.variation
  const variation = preferred !== null && project.variation_options.some((option) => option.id === preferred) ? preferred : null
  const withPseudo = session.withPseudo
  const [progress, setProgress] = useState<string | null>(null)
  const [copiesError, setCopiesError] = useState<{ message: string; nodeIds: string[] } | null>(null)
  const [copied, setCopied] = useState(false)
  const stopRef = useRef(false)

  const label = (lang: string) => reportLanguageLabel(lang, project.languages)
  const ordered = project.languages.map((language) => language.code).filter((code) => languages.includes(code))
  const sampleDrafts = useSampleDrafts(project.id, props.prefs, props.onPrefs)
  // The plural selector lists the forms of the first picked language, with the counts they render there; other
  // languages use the same pick where they have that form.
  const pluralLang = ordered.length > 0 ? ordered[0] : null
  const nodes = useMemo(() => props.state.result?.nodes ?? [], [props.state.result])
  const shapes = usePluralShapes({
    api: props.api,
    projectId: project.id,
    nodes,
    resolved: props.state.resolved,
    mainLanguage: project.main_language,
    request: pluralLang === null ? null : { lang: pluralLang, source, variationOptionId: variation },
  })
  const placeholders = useMemo(
    () => samplePlaceholders(nodes, project.id, props.state.resolved, project.main_language, shapes),
    [nodes, props.state.resolved, project.id, project.main_language, shapes],
  )

  function toggleLanguage(code: string) {
    onSession({ languages: languages.includes(code) ? languages.filter((entry) => entry !== code) : [...languages, code] })
  }

  function deps(samples: Record<string, string>): QaDeps {
    return {
      bus: props.bus,
      api: props.api,
      scan: (target) => props.workspace.scan(target),
      scanError: () => props.workspace.store.get().error,
      keyNames: () => {
        const names = new Map<string, string>()
        for (const [keyId, remote] of props.workspace.store.get().remote) {
          if (remote.key !== null) names.set(keyId, remote.key)
        }
        return names
      },
      choicesFor: (lang): RenderChoices => ({
        samples,
        plural: activePluralChoice(props.pluralChoice, project.id, lang),
      }),
    }
  }

  // Takes the work lock for the report or the copies; false when another canvas task holds it.
  function start(kind: "report" | "copies"): boolean {
    if (props.resetting || !props.work.acquire(kind)) {
      return false
    }
    setBusy(kind)
    setError(null)
    setRefusal(null)
    setCopiesError(null)
    setProgress(null)
    return true
  }

  function finish(kind: "report" | "copies") {
    setBusy(null)
    setProgress(null)
    props.work.release(kind)
  }

  async function runReport() {
    const picked = withPseudo ? [...ordered, PSEUDO_LANGUAGE] : ordered
    if (!start("report")) return
    stopRef.current = false
    try {
      const report = await runOverflowReport(
        {
          ...deps(sampleDrafts.commit()),
          reset: (nodeIds) => props.onReportReset(scope, nodeIds),
          onProgress: (step) => setProgress("Checking " + label(step.lang) + " (" + (step.index + 1) + " of " + step.total + ")…"),
          shouldStop: () => stopRef.current,
        },
        { scope, languages: picked, source, variationOptionId: variation, projectId: project.id, mainLanguage: project.main_language },
      )
      onSession({ report })
    } catch (caught) {
      if (caught instanceof QaRefusal) {
        setRefusal({ message: caught.message, nodeIds: caught.nodeIds })
      } else {
        setError(userMessage(caught))
      }
    } finally {
      finish("report")
    }
  }

  async function runCopies() {
    if (!start("copies")) return
    try {
      const copies = await makeLanguageCopies({ ...deps(sampleDrafts.commit()), onProgress: setProgress }, { languages: ordered, source, variationOptionId: variation, projectId: project.id })
      onSession({ copies })
    } catch (caught) {
      setCopiesError({ message: userMessage(caught), nodeIds: caught instanceof QaRefusal ? caught.nodeIds : [] })
    } finally {
      finish("copies")
    }
  }

  async function copyCsv(report: OverflowReport) {
    if (await copyText(reportCsv(report, label))) {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } else {
      props.bus.send({ type: "notify", message: "Couldn't copy to the clipboard", error: true })
    }
  }

  async function applyPseudo() {
    if (props.resetting || !props.work.acquire("pseudo")) return
    setBusy("apply")
    setError(null)
    setRefusal(null)
    setApplied(null)
    try {
      const result = await props.workspace.scan(scope)
      if (result === null) {
        setError(props.workspace.store.get().error ?? "The scan didn't finish. Try again.")
        return
      }
      const build = buildPseudoPreview(result.nodes, project.main_language)
      // One undo step for the whole run, however many batches it takes.
      const written = await runBatched(props.bus, build.items, (requestId, batch, last) => ({ type: "preview-apply", requestId, info: build.info, items: batch, ...undoStep(last) }))
      setApplied({ build, done: written.done, errors: groupErrors(written.errors) })
      await props.workspace.scan(scope)
    } catch (caught) {
      setError(userMessage(caught))
    } finally {
      setBusy(null)
      props.work.release("pseudo")
    }
  }

  async function reset() {
    setBusy("reset")
    setError(null)
    setRefusal(null)
    try {
      await props.onReset(scope)
      setApplied(null)
    } catch (caught) {
      setError(userMessage(caught))
    } finally {
      setBusy(null)
    }
  }

  const disabled = props.readOnly || busy !== null || props.resetting || props.locked
  const variationOptions = [{ value: NO_VARIATION, text: "No variation" }, ...project.variation_options.map((option) => ({ value: option.id, text: option.value }))]
  const report = session.report
  const copies = session.copies
  const scopeWord = scope === "page" ? "page" : "selection"

  return (
    <div style={styles.page}>
      <ScreenBody notices={props.notices} stack>
        {props.readOnly && <Note tone="warning">This file is connected to a different ReRune server.</Note>}
        <div style={styles.tightStack}>
          <Small muted>Apply to</Small>
          <SegmentedControl value={scope} options={SCOPE_OPTIONS} disabled={busy !== null} onValueChange={(value) => setScope(value as Scope)} />
        </div>
        <div style={styles.tightStack}>
          <Small muted>Languages</Small>
          {project.languages.length === 0 ? (
            <Note tone="warning">This project has no languages yet.</Note>
          ) : (
            project.languages.map((language) => (
              <label key={language.code} style={{ ...styles.row, ...styles.small, cursor: "pointer" }}>
                <CheckInput checked={languages.includes(language.code)} onChange={() => toggleLanguage(language.code)} label={language.code} />
                <span style={styles.grow}>{languageLabel(language)}</span>
              </label>
            ))
          )}
        </div>
        <div style={styles.tightStack}>
          <Small muted>Source</Small>
          <SegmentedControl value={source} options={SOURCE_OPTIONS} disabled={busy !== null} onValueChange={(value) => onSession({ source: value as ResolveSource })} />
        </div>
        {project.variation_options.length > 0 && (
          <div style={styles.tightStack}>
            <Small muted>Variation</Small>
            <Dropdown value={variation ?? NO_VARIATION} options={variationOptions} disabled={busy !== null} onValueChange={(value) => onSession({ variation: value === NO_VARIATION ? null : value })} />
          </div>
        )}
        <SamplesSection
          placeholders={placeholders}
          lang={pluralLang}
          plural={activePluralChoice(props.pluralChoice, project.id, pluralLang)}
          samples={sampleDrafts}
          saved={projectSamples(props.prefs.samples, project.id)}
          disabled={busy !== null}
          note={pluralLang === null ? "Pick a language to choose a plural form." : "Plural forms of " + label(pluralLang) + ", the first language picked."}
          onPlural={(choice) => props.onPluralChoice(choice === null ? null : { ...choice, projectId: project.id })}
        />

        <SectionTitle>Overflow report</SectionTitle>
        <Small>
          Previews each language on the layers in scope, finds text that is clipped, truncated or runs outside its frame, and lists values longer than
          their key's max length. The canvas is reset when the report ends; keep the plugin open until then.
        </Small>
        <Toggle value={withPseudo} onValueChange={(value) => onSession({ withPseudo: value })} disabled={busy !== null}>
          <Small>Include pseudo-localization</Small>
        </Toggle>
        <div style={styles.wrapRow}>
          <Button disabled={disabled || (ordered.length === 0 && !withPseudo)} loading={busy === "report"} onClick={() => void runReport()}>
            Run overflow report
          </Button>
          {busy === "report" && (
            <TextButton
              disabled={stopRef.current}
              onClick={() => {
                stopRef.current = true
                setProgress("Stopping after this language…")
              }}
            >
              Stop
            </TextButton>
          )}
        </div>
        {busy === "report" && <Loading label={progress ?? "Scanning…"} />}
        {busy === "report" && <Small muted>{KEEP_OPEN_HINT}</Small>}
        <ErrorNote message={error} />
        {refusal !== null && (
          <Note tone="warning" actions={refusal.nodeIds.length > 0 ? <TextButton onClick={() => props.onSelect(refusal.nodeIds)}>Select on canvas</TextButton> : undefined}>
            {refusal.message}
          </Note>
        )}
        {report !== null && busy !== "report" && (
          <ReportView report={report} label={label} copied={copied} onCopy={() => void copyCsv(report)} onSelect={props.onSelect} onDismiss={() => onSession({ report: null })} />
        )}

        <SectionTitle>Language copies</SectionTitle>
        <Small>
          Duplicates each selected frame once per language, to the right of the original, with the text in that language. Copies are not scanned or
          pushed; delete them when you are done. Components can't be copied: place an instance in a frame first.
        </Small>
        <div style={styles.wrapRow}>
          <Button disabled={disabled || ordered.length === 0} loading={busy === "copies"} onClick={() => void runCopies()}>
            Make language copies
          </Button>
        </div>
        {busy === "copies" && <Loading label={progress ?? "Scanning…"} />}
        {copiesError !== null && (
          <Note tone="danger" actions={copiesError.nodeIds.length > 0 ? <TextButton onClick={() => props.onSelect(copiesError.nodeIds)}>Select on canvas</TextButton> : undefined}>
            {copiesError.message}
          </Note>
        )}
        {copies !== null && busy !== "copies" && <CopiesView result={copies} label={label} onSelect={props.onSelect} onDismiss={() => onSession({ copies: null })} />}

        <SectionTitle>Pseudo-localization</SectionTitle>
        <div style={styles.tightStack}>
          <Small>
            Replaces letters with accented look-alikes and makes each text about 30–40% longer, so you can spot layers that clip or truncate before
            real translations arrive. Placeholders like {"{{name}}"} stay as they are.
          </Small>
          <Small muted>
            {PSEUDO_EXAMPLE} → {pseudoLocalize(PSEUDO_EXAMPLE)}
          </Small>
          <Small muted>Every text layer in scope is changed until you reset it, linked or not. Pseudo text is never pushed.</Small>
        </div>
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
      </ScreenBody>
      <div style={{ ...styles.footer, justifyContent: "flex-end" }}>
        <Button secondary disabled={disabled} loading={busy === "reset"} onClick={() => void reset()}>
          Reset {scopeWord}
        </Button>
        <Button disabled={disabled} loading={busy === "apply"} onClick={() => void applyPseudo()}>
          Pseudo-localize {scopeWord}
        </Button>
      </div>
    </div>
  )
}

function ReportView(props: { report: OverflowReport; label(lang: string): string; copied: boolean; onCopy(): void; onSelect(nodeIds: string[]): void; onDismiss(): void }) {
  const { report } = props
  const issues = reportIssueCount(report)
  return (
    <div style={styles.stack}>
      <Note
        tone={report.stopped === "error" ? "danger" : issues > 0 ? "warning" : "good"}
        actions={
          <div style={styles.row}>
            {issues > 0 && <TextButton onClick={props.onCopy}>{props.copied ? "Copied" : "Copy CSV"}</TextButton>}
            <TextButton onClick={props.onDismiss}>Dismiss</TextButton>
          </div>
        }
      >
        {report.languages.length === 0 ? "No language was checked." : issues === 0 ? "No overflow found." : plural(issues, "issue", "issues") + " found."}
        {report.stopped === "cancelled" ? " Stopped before the last language." : ""}
        {report.stopped === "error" && report.error !== null ? " The report stopped: " + report.error : ""}
        {report.truncatedScan ? " Only the first 5,000 text layers in scope were checked." : ""}
      </Note>
      {report.resetError !== null && <Note tone="danger">The canvas couldn't be reset: {report.resetError} Use Reset in the header.</Note>}
      {report.languages.map((language) => (
        <LanguageReportView key={language.lang} language={language} report={report} label={props.label} onSelect={props.onSelect} />
      ))}
    </div>
  )
}

function LanguageReportView(props: { language: LanguageReport; report: OverflowReport; label(lang: string): string; onSelect(nodeIds: string[]): void }) {
  const { language, report } = props
  const ids = [...new Set(language.rows.map((row) => row.nodeId))]
  return (
    <div style={styles.tightStack}>
      <div style={styles.row}>
        <span style={{ ...styles.small, fontWeight: "600", ...styles.grow }}>{props.label(language.lang)}</span>
        <Small muted>
          {plural(language.rows.length, "issue", "issues")} · {plural(language.checked, "layer", "layers")} checked
        </Small>
      </div>
      {language.missing > 0 && <Small muted>{plural(language.missing, "layer has", "layers have")} no value in this language and kept the source text.</Small>}
      <ErrorGroups groups={groupErrors(language.errors)} onSelect={props.onSelect} />
      {language.rows.map((row, index) => {
        const node = report.nodes.get(row.nodeId)
        return (
          <div key={row.nodeId + row.kind + index} style={{ ...styles.card, flexDirection: "row", alignItems: "center", gap: "8px" }}>
            <div style={{ ...styles.grow, ...styles.tightStack }}>
              <div style={styles.wrapRow}>
                <Chip tone={KIND_TONES[row.kind]}>{kindLabel(row.kind)}</Chip>
                <Small>{amountText(row)}</Small>
              </div>
              <Small muted>
                {preview(node?.name ?? row.nodeId, 60)}
                {node?.frameName ? " · " + preview(node.frameName, 40) : ""}
              </Small>
              {node?.keyName ? <div style={styles.mono}>{node.keyName}</div> : null}
            </div>
            <TextButton onClick={() => props.onSelect([row.nodeId])}>Select</TextButton>
          </div>
        )
      })}
      {ids.length > 1 && <TextButton onClick={() => props.onSelect(ids)}>Select all ({ids.length})</TextButton>}
    </div>
  )
}

function CopiesView(props: { result: CopiesResult; label(lang: string): string; onSelect(nodeIds: string[]): void; onDismiss(): void }) {
  const { result } = props
  const frames = result.framesCopied
  return (
    <div style={styles.stack}>
      <Note tone={result.made > 0 && result.errors.length === 0 && result.refused.length === 0 ? "good" : "warning"} actions={<TextButton onClick={props.onDismiss}>Dismiss</TextButton>}>
        Made {plural(result.made, "copy", "copies")} of {plural(frames, "frame", "frames")} ({plural(result.written, "layer", "layers")} translated).
        {result.variableSkipped > 0 ? " " + plural(result.variableSkipped, "layer uses", "layers use") + " a Figma variable and kept its text." : ""}
        {result.truncatedScan ? " The page has more than 5,000 text layers; layers after them kept the source text." : ""}
      </Note>
      <ErrorGroups groups={groupErrors(result.refused)} onSelect={props.onSelect} />
      <ErrorGroups groups={groupErrors(result.errors)} onSelect={props.onSelect} />
      {result.missing.map((missing) => (
        <Note key={missing.lang} tone="info" actions={<TextButton onClick={() => props.onSelect(missing.entries.map((entry) => entry.nodeId))}>Select originals</TextButton>}>
          {props.label(missing.lang)}: {plural(missing.entries.length, "layer has", "layers have")} no value and kept the source text (
          {missing.entries
            .slice(0, 3)
            .map((entry) => entry.keyName)
            .join(", ")}
          {missing.entries.length > 3 ? ", …" : ""}).
        </Note>
      ))}
    </div>
  )
}
