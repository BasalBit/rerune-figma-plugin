import { Bold, Button, Container, Muted, Stack, Text, VerticalSpace } from "@create-figma-plugin/ui"
import { h } from "preact"
import type { MainToUiOf } from "../../shared/messages"
import { inspectModel } from "../inspect-model"

export interface InspectScreenProps {
  selection: MainToUiOf<"inspect-selection"> | null
  copiedKey: string | null
  showDiagnostics: boolean
  onCopy(keyName: string): void
  onOpenDiagnostics(): void
}

const rowStyle = {
  border: "1px solid var(--figma-color-border)",
  borderRadius: "6px",
  padding: "8px",
  display: "flex",
  alignItems: "center",
  gap: "8px",
}

const nameStyle = { flex: "1", minWidth: "0", overflowWrap: "anywhere" as const }

export function InspectScreen(props: InspectScreenProps) {
  const model = inspectModel(props.selection)
  return (
    <Container space="medium">
      <VerticalSpace space="medium" />
      {model.kind === "empty" && (
        <Text>
          <Muted>Select a text layer or a frame to see its ReRune keys.</Muted>
        </Text>
      )}
      {model.kind === "unlinked" && (
        <Text>
          <Muted>No ReRune key is linked to this layer.</Muted>
        </Text>
      )}
      {model.kind === "keys" && (
        <Stack space="small">
          {model.keys.map((key) => (
            <div key={key.keyId} style={rowStyle}>
              <div style={nameStyle}>
                <Text>
                  <Bold>{key.keyName}</Bold>
                </Text>
                <VerticalSpace space="extraSmall" />
                <Text>
                  <Muted>
                    {key.layerText}
                    {key.layers > 1 ? ` · ${key.layers} layers` : ""}
                    {key.state === "inherited" ? " · from main component" : ""}
                    {key.state === "copied" ? " · copied layer" : ""}
                  </Muted>
                </Text>
              </div>
              <Button secondary onClick={() => props.onCopy(key.keyName)}>
                {props.copiedKey === key.keyName ? "Copied" : "Copy"}
              </Button>
            </div>
          ))}
        </Stack>
      )}
      {props.showDiagnostics && (
        <div>
          <VerticalSpace space="large" />
          <Button secondary onClick={props.onOpenDiagnostics}>
            Diagnostics
          </Button>
        </div>
      )}
      <VerticalSpace space="medium" />
    </Container>
  )
}
