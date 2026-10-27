import { Button, Textbox } from "@create-figma-plugin/ui"
import { h } from "preact"
import { useState } from "preact/hooks"
import type { ParsedFigmaUrl } from "../../shared/figma-url"
import { userMessage } from "../api/client"
import { BRANCH_MESSAGE, FILE_LINK_ACTION_LABELS, readFileLinkInput, type FileLinkAction, type FileLinkNotice } from "../state/file-link"
import { Note, Small, styles, TextButton } from "./ui"

// The pasted Figma file link (§7.7, Phase 2) and the banner that says why link sync is off (§7.11).

export const FILE_LINK_PLACEHOLDER = "https://www.figma.com/design/…"
export const DANGER_TEXT = { color: "var(--figma-color-text-danger)" }

// Live feedback while typing or pasting a link; shared by the Project screen field and the Settings form.
export function FileLinkFeedback(props: { text: string }) {
  const input = readFileLinkInput(props.text)
  if (input.kind === "invalid") {
    return <Small style={DANGER_TEXT}>{input.message}</Small>
  }
  if (input.kind === "valid" && input.link.branchKey !== null) {
    return <Small muted>This is a branch link. {BRANCH_MESSAGE}</Small>
  }
  return null
}

// Settings: paste a link and save it. `onSave` returns a warning to show (E14 failed) or null.
export function FileLinkForm(props: { disabled: boolean; saveLabel: string; onSave(link: ParsedFigmaUrl): Promise<string | null> }) {
  const [text, setText] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<{ warning: string | null } | null>(null)
  const input = readFileLinkInput(text)

  async function save() {
    if (input.kind !== "valid") {
      return
    }
    setSaving(true)
    setError(null)
    setSaved(null)
    try {
      const warning = await props.onSave(input.link)
      setText("")
      setSaved({ warning })
    } catch (caught) {
      setError(userMessage(caught))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={styles.tightStack}>
      <Textbox
        value={text}
        placeholder={FILE_LINK_PLACEHOLDER}
        disabled={props.disabled || saving}
        spellCheck={false}
        onValueInput={(value) => {
          setText(value)
          setError(null)
          setSaved(null)
        }}
      />
      <FileLinkFeedback text={text} />
      {error !== null && <Small style={DANGER_TEXT}>{error}</Small>}
      <div style={styles.row}>
        <Button disabled={props.disabled || saving || input.kind !== "valid"} loading={saving} onClick={() => void save()}>
          {props.saveLabel}
        </Button>
        {saved !== null && saved.warning === null && <Small muted>Saved to this file.</Small>}
      </div>
      {saved !== null && saved.warning !== null && <Note tone="warning">{saved.warning}</Note>}
    </div>
  )
}

// Above the workspace while link sync is off: a suspected copy (answer required), a branch, no link, no edit_keys.
export function FileLinkNote(props: { notice: FileLinkNotice; busy: boolean; disabled: boolean; onAction(action: FileLinkAction): void; onDismiss(): void }) {
  const { notice } = props
  return (
    <Note
      tone={notice.tone}
      actions={
        notice.actions.length > 0 || notice.dismissible ? (
          <div style={styles.row}>
            {notice.actions.map((action) => (
              <TextButton key={action} disabled={props.busy || (props.disabled && action === "same-file")} onClick={() => props.onAction(action)}>
                {FILE_LINK_ACTION_LABELS[action]}
              </TextButton>
            ))}
            {notice.dismissible && <TextButton onClick={props.onDismiss}>Not now</TextButton>}
          </div>
        ) : undefined
      }
    >
      {notice.message}
    </Note>
  )
}
