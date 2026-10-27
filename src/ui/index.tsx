import { Button, Container, Muted, render, Text, VerticalSpace } from "@create-figma-plugin/ui"
import { h } from "preact"
import { useEffect, useMemo, useState } from "preact/hooks"
import type { MainToUiOf } from "../shared/messages"
import { browserEnvironment, createUiBus, type UiBus } from "./bus"
import { copyText } from "./clipboard"
import { DiagnosticsScreen } from "./screens/diagnostics"
import { InspectScreen } from "./screens/inspect"

type Init = MainToUiOf<"init">

const COPIED_RESET_MS = 1500

// Dev Mode inspect panel (Phase 1 minimum): linked key names with Copy; development builds add Diagnostics.
function InspectApp(props: { bus: UiBus; init: Init }) {
  const [selection, setSelection] = useState<MainToUiOf<"inspect-selection"> | null>(null)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const [view, setView] = useState<"inspect" | "diagnostics">("inspect")
  const development = props.init.env === "development"

  useEffect(() => {
    const off = props.bus.on("inspect-selection", setSelection)
    props.bus.send({ type: "inspect-request" })
    return off
  }, [props.bus])

  async function copy(keyName: string) {
    if (await copyText(keyName)) {
      setCopiedKey(keyName)
      setTimeout(() => setCopiedKey((current) => (current === keyName ? null : current)), COPIED_RESET_MS)
    } else {
      props.bus.send({ type: "notify", message: "Couldn't copy the key name", error: true })
    }
  }

  if (view === "diagnostics" && development) {
    return <DiagnosticsScreen bus={props.bus} editorType="dev" env={props.init.env} onBack={() => setView("inspect")} />
  }
  return (
    <InspectScreen
      selection={selection}
      copiedKey={copiedKey}
      showDiagnostics={development}
      onCopy={(keyName) => void copy(keyName)}
      onOpenDiagnostics={() => setView("diagnostics")}
    />
  )
}

// Design mode entry until the Design screens land (P1.4): version and the diagnostics spike (§7.21).
function DesignApp(props: { bus: UiBus; init: Init }) {
  const [view, setView] = useState<"home" | "diagnostics">("home")
  if (view === "diagnostics") {
    return <DiagnosticsScreen bus={props.bus} editorType="figma" env={props.init.env} onBack={() => setView("home")} />
  }
  return (
    <Container space="medium">
      <VerticalSpace space="medium" />
      <Text>ReRune {props.init.pluginVersion}</Text>
      <VerticalSpace space="small" />
      <Text>
        <Muted>{props.init.fileName}</Muted>
      </Text>
      <VerticalSpace space="large" />
      <Button secondary onClick={() => setView("diagnostics")}>
        Diagnostics
      </Button>
    </Container>
  )
}

function App() {
  const bus = useMemo(() => createUiBus(browserEnvironment()), [])
  const [init, setInit] = useState<Init | null>(null)

  useEffect(() => {
    void bus.handshake().then(setInit)
    return () => bus.dispose()
  }, [bus])

  if (init === null) {
    return (
      <Container space="medium">
        <VerticalSpace space="medium" />
        <Text>
          <Muted>Loading…</Muted>
        </Text>
      </Container>
    )
  }
  return init.editorType === "dev" ? <InspectApp bus={bus} init={init} /> : <DesignApp bus={bus} init={init} />
}

export default render(App)
