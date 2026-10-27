import { Container, render, Text, VerticalSpace } from "@create-figma-plugin/ui"
import { h } from "preact"

function App(props: { mode?: string }) {
  return (
    <Container space="medium">
      <VerticalSpace space="medium" />
      <Text>ReRune {__PLUGIN_VERSION__}</Text>
      <VerticalSpace space="small" />
      <Text>{props.mode === "inspect" ? "Dev Mode" : "Design"}</Text>
    </Container>
  )
}

export default render(App)
