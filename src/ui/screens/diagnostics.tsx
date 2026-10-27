import { Button, Container, Muted, Stack, Text, VerticalSpace } from "@create-figma-plugin/ui"
import { h } from "preact"
import { useState } from "preact/hooks"
import type { BuildEnv, PluginEditorType } from "../../shared/message-policy"
import type { DiagnosticTest } from "../../shared/messages"
import type { UiBus } from "../bus"
import { copyText } from "../clipboard"
import { diagnosticsFor, jpgSampleOf, messageFor, printableReport, withUiFacts } from "../diagnostics"
import { cornerPixel } from "../image"

// Diagnostics (§7.21): runs the spike tests the main bus allows here and shows the JSON report with
// "Copy report". The UI chunk adds the "Network check" (E1) through `networkCheck`.

export interface DiagnosticsScreenProps {
  bus: UiBus
  editorType: PluginEditorType
  env: BuildEnv
  onBack(): void
  networkCheck?: () => Promise<unknown>
}

const EXPORT_IDLE_MS = 300000
const preStyle = {
  whiteSpace: "pre-wrap" as const,
  overflowWrap: "anywhere" as const,
  fontFamily: "var(--font-family-code, monospace)",
  fontSize: "11px",
  maxHeight: "320px",
  overflow: "auto",
  border: "1px solid var(--figma-color-border)",
  borderRadius: "6px",
  padding: "8px",
}

export function DiagnosticsScreen(props: DiagnosticsScreenProps) {
  const [running, setRunning] = useState<string | null>(null)
  const [result, setResult] = useState<{ title: string; text: string } | null>(null)
  const [copied, setCopied] = useState(false)

  async function run(test: DiagnosticTest) {
    setRunning(test)
    setCopied(false)
    try {
      const report = await props.bus.request((requestId) => messageFor(test, requestId), {
        done: (message) => (message.type === "diagnostics-result" ? message.report : undefined),
        idleMs: test === "T3-export" || test === "T4-export-page" ? EXPORT_IDLE_MS : undefined,
      })
      const sample = jpgSampleOf(report)
      const pixel = sample === null ? null : await cornerPixel(sample, "image/jpeg")
      const full = withUiFacts(test, report, { userAgent: navigator.userAgent, cornerPixel: pixel })
      setResult({ title: test, text: printableReport(full) })
    } catch (error) {
      setResult({ title: test, text: error instanceof Error ? error.message : String(error) })
    } finally {
      setRunning(null)
    }
  }

  async function runNetworkCheck(check: () => Promise<unknown>) {
    setRunning("network")
    try {
      setResult({ title: "Network check", text: printableReport(await check()) })
    } catch (error) {
      setResult({ title: "Network check", text: error instanceof Error ? error.message : String(error) })
    } finally {
      setRunning(null)
    }
  }

  async function copy() {
    if (result !== null) {
      setCopied(await copyText(result.text))
    }
  }

  return (
    <Container space="medium">
      <VerticalSpace space="medium" />
      <Button secondary onClick={props.onBack}>
        Back
      </Button>
      <VerticalSpace space="medium" />
      <Text>
        <Muted>Run a test, then paste the report into TESTING.md.</Muted>
      </Text>
      <VerticalSpace space="small" />
      <Stack space="extraSmall">
        {diagnosticsFor(props.editorType, props.env).map((entry) => (
          <div key={entry.test} title={entry.hint}>
            <Button fullWidth secondary disabled={running !== null} loading={running === entry.test} onClick={() => void run(entry.test)}>
              {entry.label}
            </Button>
          </div>
        ))}
        {props.networkCheck !== undefined && (
          <Button fullWidth secondary disabled={running !== null} onClick={() => void runNetworkCheck(props.networkCheck as () => Promise<unknown>)}>
            Network check
          </Button>
        )}
      </Stack>
      {result !== null && (
        <div>
          <VerticalSpace space="medium" />
          <Text>{result.title}</Text>
          <VerticalSpace space="extraSmall" />
          <pre style={preStyle}>{result.text}</pre>
          <VerticalSpace space="small" />
          <Button onClick={() => void copy()}>{copied ? "Copied" : "Copy report"}</Button>
        </div>
      )}
      <VerticalSpace space="medium" />
    </Container>
  )
}
