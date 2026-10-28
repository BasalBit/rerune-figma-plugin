import { Dropdown, Textbox } from "@create-figma-plugin/ui"
import { h } from "preact"
import type { PluralChoice } from "../../shared/icu"
import { AUTOMATIC, categoryOptions, sampleHint, type SamplePlaceholder } from "../state/samples"
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
  const options = props.lang === null ? [] : categoryOptions(props.lang)
  return (
    <div style={styles.tightStack}>
      {props.placeholders.map((placeholder) => (
        <div key={placeholder.name} style={styles.tightStack}>
          <div style={styles.row}>
            <span style={{ ...styles.mono, ...styles.grow }}>{placeholder.name}</span>
            {placeholder.kind === "plural" && options.length > 0 && (
              <div style={{ width: "150px" }}>
                <Dropdown
                  value={props.plural !== null && props.plural.variable === placeholder.name ? props.plural.category : AUTOMATIC}
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
            disabled={props.disabled === true || (props.plural !== null && props.plural.variable === placeholder.name)}
            onValueInput={(value) => props.onDraft(placeholder.name, value)}
            onBlur={props.onCommit}
          />
          <Small muted>{props.plural !== null && props.plural.variable === placeholder.name ? "Set by the plural form " + props.plural.category : sampleHint(placeholder)}</Small>
        </div>
      ))}
      <TextButton disabled={props.disabled} onClick={props.onClear}>
        Clear samples
      </TextButton>
    </div>
  )
}
