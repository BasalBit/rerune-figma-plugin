import type { NodeError } from "./messages"

export type NodeErrorCode = NodeError["code"]

// User-facing text for per-node results of canvas and metadata operations (§7.14, §7.15).
export const NODE_ERROR_MESSAGES: Record<NodeErrorCode, string> = {
  missing_font: "A font in this layer is missing. Install or replace it first.",
  node_not_found: "Layer not found. It may be hidden or deleted.",
  write_failed: "Figma couldn't change this layer.",
  preview_active: "Reset the preview on this layer first.",
  not_previewing: "This layer isn't showing a preview.",
  readonly_mode: "Not available in Dev Mode.",
  mixed_styles_flattened: "Some text styles couldn't be kept.",
  too_large: "This text is too long to store.",
  bound_to_variable: "Text comes from a Figma variable; change the variable instead",
  edited_during_preview: "This layer was edited during the preview.",
  override_kept: "This instance keeps a text override after reset.",
  subtree_mismatch: "This frame changed since the copy was made.",
  remote_component: "Update this text in the library file.",
}

// language-copies (§7.18.4, D32): why a frame got no copies (NodeError on the frame's id) and which part of a copy
// kept the source text (on the copy's layer). They travel as NodeError messages with the closest code.
export const LANGUAGE_COPY_MESSAGES = {
  component: "Language copies work on frames; place an instance in a frame first.",
  notFrame: "Language copies work on top-level frames and instances.",
  alreadyCopy: "This frame is already a language copy.",
  previewing: "Reset previews first.",
  failed: "Figma couldn't copy this frame.",
  mismatch: "This part of the copy differs from the original, so it kept the source text.",
} as const

// Warnings: the write happened, but the result is not exact. They do not make an op-result fail.
export const NODE_WARNING_CODES: readonly NodeErrorCode[] = ["mixed_styles_flattened", "override_kept"]

export function nodeError(nodeId: string, code: NodeErrorCode, message: string = NODE_ERROR_MESSAGES[code]): NodeError {
  return { nodeId, code, message }
}

export function isWarning(error: Pick<NodeError, "code">): boolean {
  return NODE_WARNING_CODES.includes(error.code)
}

export function outcomeOk(errors: readonly NodeError[]): boolean {
  return errors.every(isWarning)
}
