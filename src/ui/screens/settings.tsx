import { Button, Checkbox, Dropdown, Textbox, Toggle } from "@create-figma-plugin/ui"
import { h, type ComponentChildren } from "preact"
import { useEffect, useState } from "preact/hooks"
import { CASE_STYLES } from "../../shared/constants"
import type { LinkSyncGate } from "../../shared/file-link"
import type { ParsedFigmaUrl } from "../../shared/figma-url"
import type { CaseStyle, FileSettings, StoredAuth } from "../../shared/messages"
import { userMessage } from "../api/client"
import { DANGER_TEXT, FileLinkForm } from "../components/file-link"
import { ErrorNote, Note, SectionTitle, Small, styles, TextButton } from "../components/ui"
import { ScreenBody } from "../components/screen-body"
import { fileLinkStatus } from "../state/file-link"
import { exampleKeyName, templateIssues } from "../state/naming"
import type { ScreenshotSetting } from "../state/screenshots"
import { applyEdit, CASE_STYLE_LABELS, editOf, sameEdit, settingsOffer, type Prefs, type SettingsEdit, type SettingsOffer, type SettingsStatus } from "../state/settings"

// Settings (§7.8): the Figma file link (Phase 2), key template, case style, ignore _ layers, include locked,
// upload screenshots on push (Phase 2; hidden for sandbox users), Advanced → Diagnostics, version, Sign out. File
// settings are written to the file (root + page mirror, §7.7); prefs stay on this machine.

export interface SettingsScreenProps {
  notices: ComponentChildren               // the workspace notices, shown first in the scroll area (ScreenBody)
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
  // Figma file link (§7.7): link sync state, save a pasted link, confirm a suspected copy. Each returns a warning
  // to show (E14 failed) or null.
  linkGate: LinkSyncGate
  onSaveFileLink(link: ParsedFigmaUrl): Promise<string | null>
  onConfirmSameFile(): Promise<string | null>
  // "Upload screenshots on push" (§7.16): whether the toggle shows and what it says.
  screenshots: ScreenshotSetting
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
      <ScreenBody notices={props.notices} stack>
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

        {props.settings !== null && (
          <FileSection settings={props.settings} gate={props.linkGate} readOnly={props.readOnly} onSave={props.onSaveFileLink} onConfirmSameFile={props.onConfirmSameFile} />
        )}

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
        {props.screenshots.visible && props.screenshots.toggle && (
          <Toggle value={props.prefs.uploadScreenshotsOnPush} onValueChange={(value) => props.onPrefs({ uploadScreenshotsOnPush: value })}>
            <Small>Upload screenshots on push</Small>
          </Toggle>
        )}
        {props.screenshots.visible && props.screenshots.hint !== null && <Small muted>{props.screenshots.hint}</Small>}

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
      </ScreenBody>
    </div>
  )
}

// The file's Figma link (§7.7): which file it names, whether links sync, "This is the same file" for a suspected
// copy, and a field to paste the link (a new link replaces the old one).
function FileSection(props: {
  settings: FileSettings
  gate: LinkSyncGate
  readOnly: boolean
  onSave(link: ParsedFigmaUrl): Promise<string | null>
  onConfirmSameFile(): Promise<string | null>
}) {
  const [confirming, setConfirming] = useState(false)
  const [message, setMessage] = useState<{ tone: "good" | "warning"; text: string } | null>(null)

  async function confirm() {
    setConfirming(true)
    setMessage(null)
    try {
      const warning = await props.onConfirmSameFile()
      setMessage(warning === null ? { tone: "good", text: "Confirmed. Links sync with ReRune again." } : { tone: "warning", text: warning })
    } catch (caught) {
      setMessage({ tone: "warning", text: userMessage(caught) })
    } finally {
      setConfirming(false)
    }
  }

  const linked = props.settings.fileKey !== null
  return (
    <div style={styles.tightStack}>
      <SectionTitle>Figma file</SectionTitle>
      {linked && (
        <div>
          <div style={{ fontWeight: "600", overflowWrap: "anywhere" }}>{props.settings.fileName ?? "This file"}</div>
          {props.settings.fileUrl !== null && <div style={{ ...styles.mono, ...styles.muted }}>{props.settings.fileUrl}</div>}
        </div>
      )}
      <Small muted={props.gate.enabled} style={props.gate.reason === "possible_copy" ? DANGER_TEXT : undefined}>
        {fileLinkStatus(props.gate)}
      </Small>
      {props.gate.reason === "possible_copy" && (
        <div>
          <Button secondary disabled={props.readOnly || confirming} loading={confirming} onClick={() => void confirm()}>
            This is the same file
          </Button>
        </div>
      )}
      {message !== null && <Note tone={message.tone}>{message.text}</Note>}
      <Small muted>{linked ? "Paste a new link to replace it (Share → Copy link):" : "Paste this file's link (Share → Copy link):"}</Small>
      <FileLinkForm disabled={props.readOnly} saveLabel={linked ? "Replace link" : "Save link"} onSave={props.onSave} />
    </div>
  )
}
