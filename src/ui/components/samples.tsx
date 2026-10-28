import { Dropdown, Textbox } from "@create-figma-plugin/ui"
import { h } from "preact"
import type { PluralChoice } from "../../shared/icu"
import { AUTOMATIC, categoryOptions, chosenCategory, sampleHint, type SamplePlaceholder } from "../state/samples"
import { Small, styles, TextButton } from "./ui"

// Sample values per placeholder and the plural form selector (§7.18.5). The parent keeps the typed drafts and
// saves them (prefs, per project); one plural variable at a time gets a chosen category.

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
