import { Dropdown, Textbox } from "@create-figma-plugin/ui"
import { h } from "preact"
import { useEffect, useRef, useState } from "preact/hooks"
import type { PluralChoice } from "../../shared/icu"
import { AUTOMATIC, categoryOptions, chosenCategory, projectSamples, sameSamples, sampleHint, samplesSummary, withDrafts, type SamplePlaceholder } from "../state/samples"
import type { Prefs } from "../state/settings"
import { Small, styles, TextButton } from "./ui"

// Sample values per placeholder and the plural form selector (§7.18.5), on the Preview and QA screens. Each screen
// keeps its own typed drafts of the project's saved samples (prefs, per project); one plural variable at a time
// gets a chosen category, shared by both screens for the session.

export interface SampleDrafts {
  drafts: Record<string, string>
  setDraft(name: string, value: string): void
  // Saves the drafts to prefs when they changed; returns the samples to render with.
  commit(): Record<string, string>
  clear(): void
}

// The typed samples of one project: saved on blur, before each run (commit) and when the screen closes.
export function useSampleDrafts(projectId: string, prefs: Prefs, onPrefs: (patch: Partial<Prefs>) => void): SampleDrafts {
  const [drafts, setDrafts] = useState<Record<string, string>>(() => ({ ...projectSamples(prefs.samples, projectId) }))
  const draftsRef = useRef(drafts)
  draftsRef.current = drafts
  const prefsRef = useRef(prefs)
  prefsRef.current = prefs
  const onPrefsRef = useRef(onPrefs)
  onPrefsRef.current = onPrefs
  function commit(): Record<string, string> {
    const next = withDrafts(prefsRef.current.samples, projectId, draftsRef.current)
    const samples = projectSamples(next, projectId)
    if (!sameSamples(samples, projectSamples(prefsRef.current.samples, projectId))) {
      onPrefsRef.current({ samples: next })
      prefsRef.current = { ...prefsRef.current, samples: next }
    }
    return samples
  }
  // Drafts typed just before leaving the screen are saved too.
  useEffect(() => () => void commit(), [])
  return {
    drafts,
    setDraft: (name, value) => setDrafts((current) => ({ ...current, [name]: value })),
    commit,
    clear: () => {
      draftsRef.current = {}
      setDrafts({})
      commit()
    },
  }
}

export interface SamplesSectionProps {
  placeholders: readonly SamplePlaceholder[]
  lang: string | null                     // the language whose plural forms the selector lists
  plural: PluralChoice | null             // the plural choice that applies to `lang`
  samples: SampleDrafts
  saved: Record<string, string>           // the project's saved samples, for the summary
  disabled: boolean
  note?: string | null                    // a line above the editor (QA: which language's plural forms it lists)
  onPlural(choice: PluralChoice | null): void
}

// "Sample values and plural forms" with Edit / Hide: the summary when collapsed, the editor when open.
export function SamplesSection(props: SamplesSectionProps) {
  const [open, setOpen] = useState(false)
  const count = props.placeholders.length
  return (
    <div style={styles.tightStack}>
      <div style={styles.row}>
        <Small muted style={styles.grow}>
          Sample values and plural forms{count > 0 ? " (" + count + ")" : ""}
        </Small>
        <TextButton onClick={() => setOpen(!open)}>{open ? "Hide" : "Edit"}</TextButton>
      </div>
      {open ? (
        <div style={styles.tightStack}>
          {props.note !== undefined && props.note !== null && count > 0 && <Small muted>{props.note}</Small>}
          <SamplesEditor
            placeholders={props.placeholders}
            lang={props.lang}
            drafts={props.samples.drafts}
            plural={props.plural}
            disabled={props.disabled}
            onDraft={props.samples.setDraft}
            onCommit={() => void props.samples.commit()}
            onPlural={props.onPlural}
            onClear={() => {
              props.samples.clear()
              props.onPlural(null)
            }}
          />
        </div>
      ) : (
        <Small muted>{samplesSummary(props.placeholders, props.saved, props.plural, props.lang) ?? "Placeholders show as [name]; plural messages show their other form."}</Small>
      )}
    </div>
  )
}

export interface SamplesEditorProps {
  placeholders: readonly SamplePlaceholder[]
  lang: string | null
  drafts: Record<string, string>
  plural: PluralChoice | null
  disabled?: boolean
  onDraft(name: string, value: string): void
  onCommit(): void
  onPlural(choice: PluralChoice | null): void
  onClear(): void
}

export function SamplesEditor(props: SamplesEditorProps) {
  if (props.placeholders.length === 0) {
    return <Small muted>The keys linked in the scanned layers have no placeholders.</Small>
  }
  const lang = props.lang
  return (
    <div style={styles.tightStack}>
      {props.placeholders.map((placeholder) => {
        const options = lang === null || placeholder.kind !== "plural" ? [] : categoryOptions(lang, placeholder.plural)
        const chosen = chosenCategory(placeholder, lang, props.plural)
        return (
          <div key={placeholder.name} style={styles.tightStack}>
            <div style={styles.row}>
              <span style={{ ...styles.mono, ...styles.grow }}>{placeholder.name}</span>
              {options.length > 0 && (
                <div style={{ width: "150px" }}>
                  <Dropdown
                    value={chosen ?? AUTOMATIC}
                    options={options}
                    disabled={props.disabled}
                    onValueChange={(value) => props.onPlural(value === AUTOMATIC ? null : { variable: placeholder.name, category: value })}
                  />
                </div>
              )}
            </div>
            <Textbox
              value={props.drafts[placeholder.name] ?? ""}
              placeholder={placeholder.kind === "plural" ? "Number, e.g. 3" : "[" + placeholder.name + "]"}
              spellCheck={false}
              disabled={props.disabled === true || chosen !== null}
              onValueInput={(value) => props.onDraft(placeholder.name, value)}
              onBlur={props.onCommit}
            />
            <Small muted>{chosen !== null ? "Set by the plural form " + chosen : sampleHint(placeholder)}</Small>
          </div>
        )
      })}
      <TextButton disabled={props.disabled} onClick={props.onClear}>
        Clear samples
      </TextButton>
    </div>
  )
}
