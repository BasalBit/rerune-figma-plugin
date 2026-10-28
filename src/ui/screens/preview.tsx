import { Button, Dropdown, SegmentedControl, Toggle } from "@create-figma-plugin/ui"
import { h } from "preact"
import { useEffect, useMemo, useRef, useState } from "preact/hooks"
import type { FigmaProjectDetail } from "../../shared/api-types"
import type { ResolveSource, Scope } from "../../shared/messages"
import { userMessage } from "../api/client"
import type { FigmaApi } from "../api/figma-api"
import type { UiBus } from "../bus"
import { SamplesEditor } from "../components/samples"
import { ErrorGroups, ErrorNote, Loading, Note, plural, preview, SectionTitle, Small, styles, TextButton } from "../components/ui"
import { groupErrors, runBatched, type ErrorGroup } from "../state/ops"
import {
  buildPreview,
  defaultLanguage,
  languageLabel,
  previewKeyIds,
  resolveForPreview,
  type PreviewBuild,
  type PreviewMode,
} from "../state/preview"
import { activePluralChoice, projectSamples, samplePlaceholders, samplesSummary, sameSamples, withDrafts, type ProjectPluralChoice } from "../state/samples"
import type { Prefs } from "../state/settings"
import type { Workspace, WorkspaceState } from "../state/workspace"

// Preview (§7.8, §7.14, D24): language (with its inheritance chain), Draft/Published, variation, "Show key names",
// sample values and plural forms (§7.18.5), Apply to selection/page, Reset, the missing list with Select/Zoom and
// the values longer than their key's max length (§7.18.3).

export interface PreviewScreenProps {
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
  resetting: boolean                      // a reset started elsewhere (Nav, Push) is running
  onApplying(applying: boolean): void     // lets the app hold other resets while previews are written
  pluralChoice: ProjectPluralChoice | null
  onPluralChoice(choice: ProjectPluralChoice | null): void
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

interface Applied { build: PreviewBuild; done: number; errors: ErrorGroup[] }

export function PreviewScreen(props: PreviewScreenProps) {
  const { project, prefs } = props
  const [lang, setLang] = useState<string | null>(() => defaultLanguage(project, prefs.lastLanguage))
  const [source, setSource] = useState<ResolveSource>(prefs.lastSource)
  const [variation, setVariation] = useState<string | null>(() =>
    prefs.lastVariationOptionId !== null && project.variation_options.some((option) => option.id === prefs.lastVariationOptionId) ? prefs.lastVariationOptionId : null,
  )
  const [keysMode, setKeysMode] = useState(false)
  const [scope, setScope] = useState<Scope>(props.state.scope)
  const [busy, setBusy] = useState<"apply" | "reset" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [applied, setApplied] = useState<Applied | null>(null)
  const [showInherited, setShowInherited] = useState(false)
  const [showSamples, setShowSamples] = useState(false)
  const saved = projectSamples(prefs.samples, project.id)
  const [drafts, setDrafts] = useState<Record<string, string>>(() => ({ ...saved }))
  const placeholders = useMemo(
    () => samplePlaceholders(props.state.result?.nodes ?? [], project.id, props.state.resolved, project.main_language),
    [props.state.result, props.state.resolved, project.id, project.main_language],
  )
  const activePlural = activePluralChoice(props.pluralChoice, project.id, lang)

  // Saves the typed samples (prefs, per project) when they changed; returns the samples to render with.
  const draftsRef = useRef(drafts)
  draftsRef.current = drafts
  const prefsRef = useRef(prefs)
  prefsRef.current = prefs
  function commitSamples(): Record<string, string> {
    const next = withDrafts(prefsRef.current.samples, project.id, draftsRef.current)
    const samples = projectSamples(next, project.id)
    if (!sameSamples(samples, projectSamples(prefsRef.current.samples, project.id))) {
      props.onPrefs({ samples: next })
    }
    return samples
  }
  // Drafts typed just before leaving the screen are saved too.
  useEffect(() => () => void commitSamples(), [])

  async function apply() {
    if (lang === null || props.resetting) return
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
      const mode: PreviewMode = keysMode ? "keys" : source
      const request = { lang, mode, variationOptionId: variation }
      const resolved = await resolveForPreview(props.api, project.id, previewKeyIds(result.nodes, project.id), request)
      const names = new Map<string, string>()
      for (const [keyId, remote] of props.workspace.store.get().remote) {
        if (remote.key !== null) names.set(keyId, remote.key)
      }
      const samples = commitSamples()
      const build = buildPreview(result.nodes, project.id, request, resolved, names, { samples, plural: activePlural })
      const written = await runBatched(props.bus, build.items, (requestId, batch) => ({ type: "preview-apply", requestId, info: build.info, items: batch }))
      setApplied({ build, done: written.done, errors: groupErrors(written.errors) })
      props.onPrefs({ lastLanguage: lang, lastSource: source, lastVariationOptionId: variation })
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

  const languageOptions = project.languages.map((language) => ({ value: language.code, text: languageLabel(language) }))
  const variationOptions = [{ value: NO_VARIATION, text: "No variation" }, ...project.variation_options.map((option) => ({ value: option.id, text: option.value }))]
  const disabled = props.readOnly || busy !== null || props.resetting

  return (
    <div style={styles.page}>
      <div style={{ ...styles.body, ...styles.stack }}>
        {props.readOnly && <Note tone="warning">This file is connected to a different ReRune server.</Note>}
        <div style={styles.tightStack}>
          <Small muted>Language</Small>
          {languageOptions.length === 0 ? (
            <Note tone="warning">This project has no languages yet.</Note>
          ) : (
            <Dropdown value={lang} options={languageOptions} onValueChange={setLang} />
          )}
        </div>
        <div style={styles.tightStack}>
          <Small muted>Source</Small>
          <SegmentedControl value={source} options={SOURCE_OPTIONS} disabled={keysMode} onValueChange={(value) => setSource(value as ResolveSource)} />
        </div>
        {project.variation_options.length > 0 && (
          <div style={styles.tightStack}>
            <Small muted>Variation</Small>
            <Dropdown value={variation ?? NO_VARIATION} options={variationOptions} disabled={keysMode} onValueChange={(value) => setVariation(value === NO_VARIATION ? null : value)} />
          </div>
        )}
        <Toggle value={keysMode} onValueChange={setKeysMode}>
          <Small>Show key names instead of text</Small>
        </Toggle>
        {!keysMode && (
          <div style={styles.tightStack}>
            <div style={styles.row}>
              <Small muted style={styles.grow}>
                Sample values and plural forms{placeholders.length > 0 ? " (" + placeholders.length + ")" : ""}
              </Small>
              <TextButton onClick={() => setShowSamples(!showSamples)}>{showSamples ? "Hide" : "Edit"}</TextButton>
            </div>
            {showSamples ? (
              <SamplesEditor
                placeholders={placeholders}
                lang={lang}
                drafts={drafts}
                plural={activePlural}
                disabled={busy !== null}
                onDraft={(name, value) => setDrafts((current) => ({ ...current, [name]: value }))}
                onCommit={() => void commitSamples()}
                onPlural={(choice) => props.onPluralChoice(choice === null ? null : { ...choice, projectId: project.id })}
                onClear={() => {
                  draftsRef.current = {}
                  setDrafts({})
                  commitSamples()
                  props.onPluralChoice(null)
                }}
              />
            ) : (
              <Small muted>{samplesSummary(placeholders, saved, activePlural, lang) ?? "Placeholders show as [name]; plural messages show their other form."}</Small>
            )}
          </div>
        )}
        <div style={styles.tightStack}>
          <Small muted>Apply to</Small>
          <SegmentedControl value={scope} options={SCOPE_OPTIONS} onValueChange={(value) => setScope(value as Scope)} />
        </div>
        <Small muted>Previews change layers only until you reset them. Preview text is never pushed.</Small>
        <ErrorNote message={error} />
        {busy === "apply" && <Loading label="Applying preview…" />}
        {applied !== null && (
          <div style={styles.stack}>
            <Note tone="good">
              Previewing {applied.build.info.lang} on {plural(applied.done, "layer", "layers")}.
              {applied.build.skipped.variable.length > 0 ? " " + plural(applied.build.skipped.variable.length, "layer uses", "layers use") + " a Figma variable and kept its text." : ""}
            </Note>
            <ErrorGroups groups={applied.errors} onSelect={props.onSelect} />
            {applied.build.missing.length > 0 && (
              <div>
                <SectionTitle>Missing translations ({applied.build.missing.length})</SectionTitle>
                <Small muted>These layers keep the source text.</Small>
                <div style={{ ...styles.tightStack, marginTop: "6px" }}>
                  {applied.build.missing.map((entry) => (
                    <div key={entry.nodeId} style={{ ...styles.row, ...styles.card, flexDirection: "row" }}>
                      <div style={styles.grow}>
                        <div style={styles.mono}>{entry.keyName}</div>
                        <Small muted>{preview(entry.text, 100)}</Small>
                      </div>
                      <TextButton onClick={() => props.onSelect([entry.nodeId])}>Select</TextButton>
                    </div>
                  ))}
                  <TextButton onClick={() => props.onSelect(applied.build.missing.map((entry) => entry.nodeId))}>Select all missing</TextButton>
                </div>
              </div>
            )}
            {applied.build.tooLong.length > 0 && (
              <div>
                <SectionTitle>Longer than max length ({applied.build.tooLong.length})</SectionTitle>
                <Small muted>ReRune counts these values as longer than their key allows.</Small>
                <div style={{ ...styles.tightStack, marginTop: "6px" }}>
                  {applied.build.tooLong.map((entry) => (
                    <div key={entry.nodeId} style={{ ...styles.row, ...styles.card, flexDirection: "row" }}>
                      <div style={styles.grow}>
                        <div style={styles.mono}>{entry.keyName}</div>
                        <Small muted>
                          {entry.length}/{entry.maxLength} characters · {preview(entry.text, 80)}
                        </Small>
                      </div>
                      <TextButton onClick={() => props.onSelect([entry.nodeId])}>Select</TextButton>
                    </div>
                  ))}
                  <TextButton onClick={() => props.onSelect(applied.build.tooLong.map((entry) => entry.nodeId))}>Select all too long</TextButton>
                </div>
              </div>
            )}
            {applied.build.inherited.length > 0 && (
              <div>
                <SectionTitle>Inherited values ({applied.build.inherited.length})</SectionTitle>
                <TextButton onClick={() => setShowInherited(!showInherited)}>{showInherited ? "Hide" : "Show"}</TextButton>
                {showInherited && (
                  <div style={{ ...styles.tightStack, marginTop: "6px" }}>
                    {applied.build.inherited.map((entry) => (
                      <div key={entry.nodeId} style={{ ...styles.row, ...styles.card, flexDirection: "row" }}>
                        <div style={styles.grow}>
                          <div style={styles.mono}>{entry.keyName}</div>
                          <Small muted>inherited from {entry.resolvedLang}</Small>
                        </div>
                        <TextButton onClick={() => props.onSelect([entry.nodeId])}>Select</TextButton>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      <div style={{ ...styles.footer, justifyContent: "flex-end" }}>
        <Button secondary disabled={disabled} loading={busy === "reset"} onClick={() => void reset()}>
          Reset {scope === "page" ? "page" : "selection"}
        </Button>
        <Button disabled={disabled || lang === null} loading={busy === "apply"} onClick={() => void apply()}>
          Apply to {scope === "page" ? "page" : "selection"}
        </Button>
      </div>
    </div>
  )
}
