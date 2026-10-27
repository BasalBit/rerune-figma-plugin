import { Button, Checkbox, Dropdown, Textbox, Toggle } from "@create-figma-plugin/ui"
import { h } from "preact"
import { useEffect, useState } from "preact/hooks"
import { CASE_STYLES } from "../../shared/constants"
import type { CaseStyle, FileSettings, StoredAuth } from "../../shared/messages"
import { ErrorNote, Note, SectionTitle, Small, styles, TextButton } from "../components/ui"
import { exampleKeyName, templateIssues } from "../state/naming"
import { applyEdit, CASE_STYLE_LABELS, editOf, sameEdit, settingsOffer, type Prefs, type SettingsEdit, type SettingsOffer, type SettingsStatus } from "../state/settings"

// Settings (§7.8): key template, case style, ignore _ layers, include locked, Advanced → Diagnostics, version,
// Sign out. File settings are written to the file (root + page mirror, §7.7); prefs stay on this machine.

export interface SettingsScreenProps {
  settings: FileSettings | null
  status: SettingsStatus | null
  sample: readonly string[]
  prefs: Prefs
  auth: StoredAuth
  version: string
  readOnly: boolean
  onSave(settings: FileSettings): Promise<void>
  onPrefs(patch: Partial<Prefs>): void
  onChangeProject(): void
  onDiagnostics(): void
  onSignOut(): void
}

const EMPTY_EDIT: SettingsEdit = { keyTemplate: "", caseStyle: "auto", ignoreUnderscoreLayers: true, includeLocked: false }

// Repair / page-mirror offer (§7.7), shown on the Settings screen and above the other workspace screens.
export function SettingsOfferNote(props: { offer: SettingsOffer; disabled: boolean; onApply(): void; onDismiss?: () => void }) {
  return (
    <Note
      tone={props.offer.kind === "repair" ? "warning" : "info"}
      actions={
        <div style={styles.row}>
          <TextButton disabled={props.disabled} onClick={props.onApply}>
            {props.offer.action}
          </TextButton>
          {props.onDismiss !== undefined && <TextButton onClick={props.onDismiss}>Not now</TextButton>}
        </div>
      }
    >
      {props.offer.message}
    </Note>
  )
}

export function SettingsScreen(props: SettingsScreenProps) {
  const saved = props.settings === null ? EMPTY_EDIT : editOf(props.settings)
  const [edit, setEdit] = useState<SettingsEdit>(saved)
  const [saving, setSaving] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [savedNote, setSavedNote] = useState(false)

  useEffect(() => {
    setEdit(props.settings === null ? EMPTY_EDIT : editOf(props.settings))
  }, [props.settings])

  const issues = templateIssues(edit.keyTemplate)
  const dirty = !sameEdit(edit, saved)
  const canSave = props.settings !== null && !props.readOnly && dirty && issues.length === 0 && saving === null

  async function save(settings: FileSettings, label: string) {
    setSaving(label)
    setError(null)
    setSavedNote(false)
    try {
      await props.onSave(settings)
      setSavedNote(label === "save")
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The settings couldn't be saved.")
    } finally {
      setSaving(null)
    }
  }

  const example = props.settings === null ? null : exampleKeyName({ caseStyle: edit.caseStyle, keyTemplate: edit.keyTemplate.trim() === "" ? null : edit.keyTemplate.trim() }, props.sample)
  const offer = settingsOffer(props.status)

  return (
    <div style={styles.page}>
      <div style={{ ...styles.body, ...styles.stack }}>
        <ErrorNote message={error} />
        {props.settings !== null ? (
          <div style={styles.row}>
            <div style={styles.grow}>
              <Small muted>This file is connected to</Small>
              <div style={{ fontWeight: "600" }}>{props.settings.projectName}</div>
            </div>
            <TextButton onClick={props.onChangeProject}>Change project</TextButton>
          </div>
        ) : (
          <Note tone="info" actions={<TextButton onClick={props.onChangeProject}>Choose a project</TextButton>}>
            This file isn't connected to a ReRune project yet.
          </Note>
        )}
        {offer !== null && <SettingsOfferNote offer={offer} disabled={props.readOnly || saving !== null} onApply={() => void save(offer.settings, offer.kind)} />}

        <SectionTitle>Key names</SectionTitle>
        <Small muted>Template</Small>
        <Textbox value={edit.keyTemplate} placeholder="{screen}_{element} (default)" disabled={props.settings === null || props.readOnly} onValueInput={(value) => setEdit({ ...edit, keyTemplate: value })} spellCheck={false} />
        {issues.map((issue) => (
          <Small key={issue} style={{ color: "var(--figma-color-text-danger)" }}>
            {issue}
          </Small>
        ))}
        <Small muted>Placeholders: {"{page} {frame} {screen} {layer} {element} {text} {component}"}</Small>
        <Small muted>Case style</Small>
        <Dropdown
          value={edit.caseStyle}
          disabled={props.settings === null || props.readOnly}
          options={CASE_STYLES.map((style) => ({ value: style, text: CASE_STYLE_LABELS[style] }))}
          onValueChange={(value) => setEdit({ ...edit, caseStyle: value as CaseStyle })}
        />
        {example !== null && (
          <Small muted>
            Example: <span style={styles.mono}>{example}</span>
          </Small>
        )}

        <SectionTitle>Scanning</SectionTitle>
        <Checkbox value={edit.ignoreUnderscoreLayers} disabled={props.settings === null || props.readOnly} onValueChange={(value) => setEdit({ ...edit, ignoreUnderscoreLayers: value })}>
          <Small>Ignore layers whose name starts with _</Small>
        </Checkbox>
        <Checkbox value={edit.includeLocked} disabled={props.settings === null || props.readOnly} onValueChange={(value) => setEdit({ ...edit, includeLocked: value })}>
          <Small>Include locked layers</Small>
        </Checkbox>
        <div style={styles.row}>
          <Button disabled={!canSave} loading={saving === "save"} onClick={() => props.settings !== null && void save(applyEdit(props.settings, edit, Date.now()), "save")}>
            Save file settings
          </Button>
          {savedNote && !dirty && <Small muted>Saved to this file.</Small>}
        </div>

        <SectionTitle>Push</SectionTitle>
        <Toggle value={props.prefs.groupIdenticalTexts} onValueChange={(value) => props.onPrefs({ groupIdenticalTexts: value })}>
          <Small>Create one key for layers with identical text</Small>
        </Toggle>

        <SectionTitle>Advanced</SectionTitle>
        <div>
          <Button secondary onClick={props.onDiagnostics}>
            Diagnostics
          </Button>
        </div>

        <SectionTitle>Account</SectionTitle>
        <div style={styles.row}>
          <div style={{ ...styles.grow, overflowWrap: "anywhere" }}>{props.auth.user.email}</div>
          <TextButton onClick={props.onSignOut}>Sign out</TextButton>
        </div>
        <Small muted>ReRune for Figma {props.version}</Small>
      </div>
    </div>
  )
}
