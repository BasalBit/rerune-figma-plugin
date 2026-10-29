import { Dropdown, SegmentedControl } from "@create-figma-plugin/ui"
import { h, type JSX } from "preact"
import { CODEGEN_PLATFORMS, type CodegenPlatform } from "../../codegen/snippets"
import type { FigmaResolveSource } from "../../shared/api-types"
import { EmptyState } from "../brand/empty-state"
import { KeyTag } from "../brand/key-tag"
import { BrandMark } from "../brand/mark"
import { Chip, ErrorNote, Loading, Note, Small, styles, TextButton } from "../components/ui"
import { INSPECT_TRUNCATED_NOTE, NO_LANGUAGES_NOTE, valueMarker, type InspectKeyView, type InspectLoadStatus, type InspectModel, type InspectValueView } from "../state/inspect"

// Dev Mode inspect panel (§7.17): per linked key its name with Copy, status, max length, values for every project
// language (Draft/Published) with inherited/missing markers, the snippet for the chosen platform with Copy, and
// Open in ReRune. Read-only. Laid out for the 300 px minimum width of the inspect panel: the header has the mark tile
// without the wordmark, key names are key tags that wrap after their separators.

export interface InspectScreenProps {
  projectName: string
  model: InspectModel
  views: InspectKeyView[]
  status: InspectLoadStatus
  error: string | null
  noLanguages: boolean
  source: FigmaResolveSource
  platform: CodegenPlatform
  copied: string | null
  email: string
  showDiagnostics: boolean
  onSource(source: FigmaResolveSource): void
  onPlatform(platform: CodegenPlatform): void
  onCopy(id: string, text: string): void
  onOpen(url: string): void
  onRefresh(): void
  onSignOut(): void
  onOpenDiagnostics(): void
}

const SOURCE_OPTIONS = [
  { value: "draft", children: "Draft" },
  { value: "published", children: "Published" },
]

const PLATFORM_OPTIONS = CODEGEN_PLATFORMS.map((platform) => ({ value: platform.value, text: platform.label }))

const codeStyle: JSX.CSSProperties = {
  ...styles.mono,
  whiteSpace: "pre-wrap",
  margin: "0",
  padding: "6px 8px",
  borderRadius: "4px",
  background: "var(--figma-color-bg-secondary)",
}

const valueRowStyle: JSX.CSSProperties = { display: "flex", gap: "8px", alignItems: "flex-start" }
const langStyle: JSX.CSSProperties = { ...styles.mono, flexShrink: "0", width: "52px", color: "var(--rr-muted)", paddingTop: "1px" }

function copyId(kind: "name" | "snippet", keyId: string): string {
  return kind + ":" + keyId
}

function ValueRow(props: { value: InspectValueView }) {
  const { value } = props
  const marker = valueMarker(value)
  return (
    <div style={valueRowStyle}>
      <div style={langStyle} title={value.name !== "" ? value.name : value.lang}>
        {value.lang}
      </div>
      <div style={{ ...styles.grow, ...styles.tightStack }}>
        {value.state !== "missing" && <div style={{ fontSize: "11px", lineHeight: "16px", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{value.text}</div>}
        {(marker !== null || value.main || value.structured || value.tooLong) && (
          <div style={styles.wrapRow}>
            {value.main && <Chip>Source</Chip>}
            {marker !== null && <Chip tone={value.state === "missing" ? "warning" : "info"}>{marker}</Chip>}
            {value.structured && <Chip title="Plural or ICU message, shown with its “other” forms">Plural/ICU</Chip>}
            {value.tooLong && <Chip tone="danger">Too long ({value.length})</Chip>}
          </div>
        )}
      </div>
    </div>
  )
}

function KeyCard(props: { view: InspectKeyView; copied: string | null; onCopy(id: string, text: string): void; onOpen(url: string): void }) {
  const { view } = props
  const nameId = copyId("name", view.keyId)
  const snippetId = copyId("snippet", view.keyId)
  return (
    <div style={styles.card}>
      <div style={{ ...styles.row, alignItems: "flex-start" }}>
        <div style={styles.grow}>
          <KeyTag name={view.keyName} large />
        </div>
        <TextButton onClick={() => props.onCopy(nameId, view.keyName)}>{props.copied === nameId ? "Copied" : "Copy"}</TextButton>
      </div>
      {view.chips.length > 0 && (
        <div style={styles.wrapRow}>
          {view.chips.map((chip) => (
            <Chip key={chip.label} tone={chip.tone} title={chip.title}>
              {chip.label}
            </Chip>
          ))}
        </div>
      )}
      {view.layerText !== "" && <Small muted>Layer: {view.layerText}</Small>}
      {view.note !== null && <Note tone="warning">{view.note}</Note>}
      {view.loading && <Small muted>Loading values…</Small>}
      {view.values.length > 0 && (
        <div style={styles.tightStack}>
          {view.values.map((value) => (
            <ValueRow key={value.lang} value={value} />
          ))}
        </div>
      )}
      <div style={styles.tightStack}>
        <div style={{ ...styles.row, justifyContent: "space-between" }}>
          <Small muted>Code</Small>
          <TextButton onClick={() => props.onCopy(snippetId, view.snippet)}>{props.copied === snippetId ? "Copied" : "Copy code"}</TextButton>
        </div>
        <pre style={codeStyle}>{view.snippet}</pre>
      </div>
      <div>
        <TextButton onClick={() => props.onOpen(view.openUrl)}>Open in ReRune</TextButton>
      </div>
    </div>
  )
}

export function InspectScreen(props: InspectScreenProps) {
  const { model } = props
  return (
    <div style={styles.page}>
      <div style={{ borderBottom: "1px solid var(--figma-color-border)", padding: "8px 12px", ...styles.stack }}>
        <div style={styles.row}>
          <BrandMark wordmark={false} />
          <div style={{ ...styles.grow, fontWeight: "600", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={props.projectName}>
            {props.projectName}
          </div>
          <TextButton disabled={props.status === "loading"} onClick={props.onRefresh}>
            Refresh
          </TextButton>
        </div>
        <div style={{ ...styles.wrapRow, gap: "8px" }}>
          <SegmentedControl value={props.source} options={SOURCE_OPTIONS} onValueChange={(value) => props.onSource(value as FigmaResolveSource)} />
          <div style={{ flex: "1", minWidth: "120px" }}>
            <Dropdown value={props.platform} options={PLATFORM_OPTIONS} onValueChange={(value) => props.onPlatform(value as CodegenPlatform)} />
          </div>
        </div>
      </div>
      <div style={{ ...styles.body, ...styles.stack }}>
        {props.noLanguages && <Note tone="warning">{NO_LANGUAGES_NOTE}</Note>}
        <ErrorNote message={props.status === "error" ? props.error : null} onRetry={props.onRefresh} />
        {model.kind === "empty" && <EmptyState>Select a text layer or a frame to see its ReRune keys.</EmptyState>}
        {model.kind === "unlinked" && <EmptyState>No ReRune key is linked to this layer.</EmptyState>}
        {model.kind === "keys" && props.status === "loading" && props.views.every((view) => view.loading) && <Loading label="Loading values…" />}
        {props.views.map((view) => (
          <KeyCard key={view.keyId} view={view} copied={props.copied} onCopy={props.onCopy} onOpen={props.onOpen} />
        ))}
        {model.kind === "keys" && model.truncated && <Small muted>{INSPECT_TRUNCATED_NOTE}</Small>}
      </div>
      <InspectFooter email={props.email} showDiagnostics={props.showDiagnostics} onSignOut={props.onSignOut} onOpenDiagnostics={props.onOpenDiagnostics} />
    </div>
  )
}

function InspectFooter(props: { email: string | null; showDiagnostics: boolean; onSignOut?: () => void; onOpenDiagnostics(): void }) {
  if (props.email === null && !props.showDiagnostics) {
    return null
  }
  return (
    <div style={{ ...styles.footer, justifyContent: "space-between" }}>
      {props.email !== null ? (
        <Small muted style={{ ...styles.grow, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {props.email}
        </Small>
      ) : (
        <span />
      )}
      <div style={styles.row}>
        {props.showDiagnostics && <TextButton onClick={props.onOpenDiagnostics}>Diagnostics</TextButton>}
        {props.onSignOut !== undefined && <TextButton onClick={props.onSignOut}>Sign out</TextButton>}
      </div>
    </div>
  )
}

// A full-panel message: file not connected, another server, project not available, or the project loading.
export function InspectNotice(props: {
  message: string | null
  tone?: "info" | "warning" | "danger"
  loading?: string
  action?: { label: string; busy?: boolean; onClick(): void }
  email: string | null
  showDiagnostics: boolean
  onSignOut?: () => void
  onOpenDiagnostics(): void
}) {
  return (
    <div style={styles.page}>
      <div style={{ ...styles.body, ...styles.stack }}>
        {props.loading !== undefined && <Loading label={props.loading} />}
        {props.message !== null && (
          <Note
            tone={props.tone ?? "info"}
            actions={
              props.action !== undefined ? (
                <TextButton disabled={props.action.busy === true} onClick={props.action.onClick}>
                  {props.action.label}
                </TextButton>
              ) : undefined
            }
          >
            {props.message}
          </Note>
        )}
      </div>
      <InspectFooter email={props.email} showDiagnostics={props.showDiagnostics} onSignOut={props.onSignOut} onOpenDiagnostics={props.onOpenDiagnostics} />
    </div>
  )
}
