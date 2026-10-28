export type RequestId = string
export type Scope = "selection" | "page"
export type ResolveSource = "draft" | "published"

export interface StoredAuth {
  apiBase: string; token: string; tokenId: string
  tokenExpiresAt: string
  user: { id: string; email: string; firstName: string; lastName: string }; savedAt: number
}
export interface NodeLink { v: 1; id: string; k: string; p: string; src: string; nid: string; t: number }
export type LinkState = "none" | "ok" | "copied" | "inherited" | "inherited_overridden" | "invalid"
export type CaseStyle = "auto" | "snake" | "camel" | "kebab" | "pascal" | "screaming" | "dot.snake" | "dot.camel" | "dot.kebab" | "slash.snake"
export interface FileSettings {
  v: 1; apiBase: string; projectId: string; projectName: string
  fileKey: string | null; fileUrl: string | null; fileName: string | null
  branchKey: string | null
  keyTemplate: string | null; caseStyle: CaseStyle
  ignoreUnderscoreLayers: boolean; includeLocked: boolean; updatedAt: number
}
export interface PreviewInfo { lang: string; source: ResolveSource | "pseudo" | "keys"; variationOptionId: string | null; appliedAt: number }
export interface ScannedNode {
  nodeId: string; name: string; characters: string
  originalCharacters: string | null
  pageId: string; pageName: string; frameId: string | null; frameName: string | null
  parentNames: string[]
  componentName: string | null; isInstanceSublayer: boolean
  link: NodeLink | null; linkState: LinkState; preview: PreviewInfo | null
  hasMissingFont: boolean; mixedStyles: boolean; boundToComponentProperty: boolean; boundToVariable: boolean; autoRename: boolean
  textOverridden: boolean
  width: number; height: number; textAutoResize: "NONE" | "WIDTH_AND_HEIGHT" | "HEIGHT" | "TRUNCATE"
  textTruncation: "DISABLED" | "ENDING"; maxLines: number | null
}
export interface Box { nodeId: string; keyId: string; x: number; y: number; w: number; h: number }
export interface NodeError {
  nodeId: string
  code: "missing_font" | "node_not_found" | "write_failed" | "preview_active" | "not_previewing" | "readonly_mode" | "mixed_styles_flattened" | "too_large"
    | "bound_to_variable" | "edited_during_preview" | "override_kept" | "subtree_mismatch" | "remote_component"
  message: string
}
// Phase 2 addition to §7.5 (link sync, §7.11 and §7.15, D43): the current link of nodes the server has links for,
// read with skipInvisibleInstanceChildren off. "not_found": getNodeByIdAsync returned null (hidden, or a node of
// another branch or file), never treated as deleted; "unreadable": the lookup or a read threw. Metadata is set
// only for found nodes ("" / null otherwise).
export interface LinkCheck {
  nodeId: string
  status: "found" | "not_found" | "unreadable"
  linkState: LinkState
  link: NodeLink | null
  name: string; pageId: string; pageName: string; frameId: string | null; frameName: string | null
}
// Frames screenshots-export did not export (§7.16). "preview_active" is a Phase 2 addition: a frame whose text shows
// a language preview would upload preview text as the design (D23), so it is skipped until the preview is reset.
export type FrameSkipReason = "no_bounds" | "too_large" | "not_found" | "export_failed" | "preview_active"
export interface FrameSkip { frameId: string; reason: FrameSkipReason }
export interface CodegenCacheEntry { keyId: string; k: string; placeholders: string[]; sourceText: string }
export type ReadDiagnostic = "T1-check" | "T2-instances" | "T3-export" | "T4-export-page" | "T7-settings" | "T10-environment"
export type WriteDiagnostic = "T1-mark" | "T2-clear" | "T5-fonts" | "T8-relaunch"
export type DiagnosticTest = ReadDiagnostic | WriteDiagnostic | "T9-devmode-write"

export type UiToMain =
  | { type: "ui-ready" }
  | { type: "auth-save"; auth: StoredAuth }
  | { type: "auth-clear"; apiBase: string }
  | { type: "prefs-save"; prefs: Record<string, unknown> }
  | { type: "cache-save"; projectId: string; entries: CodegenCacheEntry[] }
  | { type: "settings-save"; requestId: RequestId; settings: FileSettings }
  | { type: "open-external"; url: string }
  | { type: "notify"; message: string; error?: boolean }
  | { type: "resize"; width: number; height: number }
  | { type: "select-nodes"; nodeIds: string[] }
  | { type: "scan-request"; requestId: RequestId; scope: Scope }
  | { type: "scan-cancel"; requestId: RequestId }
  | { type: "link-apply"; requestId: RequestId; items: { nodeId: string; keyId: string; keyName: string; projectId: string; src: string }[] }
  | { type: "link-remove"; requestId: RequestId; nodeIds: string[] }
  | { type: "link-check"; requestId: RequestId; nodeIds: string[]                         // Phase 2 addition (link sync)
      inheritors?: boolean }                                                              // also the page's instance sublayers inheriting from them
  | { type: "text-apply"; requestId: RequestId; items: { nodeId: string; text: string; src: string }[] }
  | { type: "preview-apply"; requestId: RequestId; info: Omit<PreviewInfo, "appliedAt">; items: { nodeId: string; text: string }[]
      commit?: false }                                                                    // Phase 3 addition: no undo step yet (more of the run follows)
  | { type: "preview-reset"; requestId: RequestId; scope: Scope; nodeIds?: string[]; edited?: "restore" | "keep" }
  | { type: "screenshots-export"; requestId: RequestId; frameIds: string[] }
  | { type: "inspect-request" }
  | { type: "overflow-check"; requestId: RequestId; nodeIds: string[]
      commit?: false }                                                                    // Phase 3 addition: as preview-apply
  | { type: "language-copies"; requestId: RequestId; frameIds: string[]; copies: { lang: string; source: ResolveSource; variationOptionId: string | null; texts: { nodeId: string; text: string }[] }[] }
  | { type: "diagnostics-read"; requestId: RequestId; test: ReadDiagnostic }
  | { type: "diagnostics-write"; requestId: RequestId; test: WriteDiagnostic }
  | { type: "diagnostics-devmode-probe"; requestId: RequestId }

export type MainToUi =
  | { type: "init"; editorType: "figma" | "dev"; mode: string; command: string; env: "production" | "development"
      apiBase: string; dashboardBase: string; pluginVersion: string; auth: StoredAuth | null; prefs: Record<string, unknown>
      fileSettings: FileSettings | null; settingsSource: "root" | "page" | "none"
      fileName: string; pageId: string; pageName: string; selectionCount: number }
  | { type: "selection-changed"; selectionCount: number; pageId: string; pageName: string }
  | { type: "scan-progress"; requestId: RequestId; scanned: number }
  | { type: "scan-batch"; requestId: RequestId; nodes: ScannedNode[] }
  | { type: "scan-done"; requestId: RequestId; total: number; truncated: boolean
      skipped: { hidden: number; locked: number; empty: number; numeric: number; underscore: number; languageCopy: number; unavailable: number } }
  | { type: "op-result"; requestId: RequestId; ok: boolean; done: number; errors: NodeError[] }
  | { type: "link-check-result"; requestId: RequestId; nodes: LinkCheck[] }               // Phase 2 addition (link sync)
  | { type: "frame-image"; requestId: RequestId; frameId: string; frameName: string; pageId: string; pageName: string
      format: "JPG" | "PNG"; bytes: Uint8Array; width: number; height: number; boxes: Box[] }
  | { type: "frame-images-done"; requestId: RequestId; exported: number; skipped: FrameSkip[] }
  | { type: "inspect-selection"; kind: "text" | "container" | "none"; nodes: ScannedNode[]
      truncated: boolean }                                                                // Phase 2 addition: linked layers left out (> 50)
  | { type: "overflow-result"; requestId: RequestId; items: { nodeId: string; kind: "clipped" | "truncated" | "exceeds_parent"; by: number }[] }
  | { type: "diagnostics-result"; requestId: RequestId; test: DiagnosticTest; report: unknown }
  | { type: "handler-error"; forType: UiToMain["type"]; requestId?: RequestId; message: string }

export type UiToMainType = UiToMain["type"]
export type MainToUiType = MainToUi["type"]
export type UiToMainOf<T extends UiToMainType> = Extract<UiToMain, { type: T }>
export type MainToUiOf<T extends MainToUiType> = Extract<MainToUi, { type: T }>
export type LinkApplyItem = UiToMainOf<"link-apply">["items"][number]
export type TextApplyItem = UiToMainOf<"text-apply">["items"][number]

// Every MainToUi type exactly once: a type missing here, or one that is not in the union, does not compile.
// The UI bus listens to all of them for request ids (the UiToMain list is MESSAGE_IMPACT in message-policy.ts).
const MAIN_TO_UI_TYPE_SET: Record<MainToUiType, true> = {
  "init": true,
  "selection-changed": true,
  "scan-progress": true,
  "scan-batch": true,
  "scan-done": true,
  "op-result": true,
  "link-check-result": true,
  "frame-image": true,
  "frame-images-done": true,
  "inspect-selection": true,
  "overflow-result": true,
  "diagnostics-result": true,
  "handler-error": true,
}

export const MAIN_TO_UI_TYPES = Object.keys(MAIN_TO_UI_TYPE_SET) as MainToUiType[]
