import {
  CASE_STYLES,
  DEFAULT_FILE_SETTINGS_OPTIONS,
  OBJECT_ID_PATTERN,
  PLUGIN_DATA_VERSION,
  RELAUNCH_DESCRIPTION_MAX_CHARS,
  RELAUNCH_DESCRIPTION_PREFIX,
} from "./constants"
import type { CaseStyle, FileSettings, LinkState, NodeLink, PreviewInfo, ResolveSource } from "./messages"
import { truncateUtf16 } from "./text"

export type ParsedLink = { kind: "none" } | { kind: "invalid" } | { kind: "link"; link: NodeLink }
export type LinkClass = "ok" | "inherited" | "inherited_overridden" | "copied"
export type RecordOwnership = "own" | "inherited" | "copied"
export type PreviewSource = PreviewInfo["source"]

export interface PreviewRecord {
  v: 1
  nid: string
  previewSrc: string
  characters: string
  autoRename: boolean
  textOverridden: boolean
  segments: unknown[] | null
  richLost: boolean
  lang: string
  source: PreviewSource
  variationOptionId: string | null
  appliedAt: number
}

export interface LangCopyMarker {
  v: 1
  nid: string
  lang: string
  source: ResolveSource
  variationOptionId: string | null
  sourceFrameId: string
  createdAt: number
}

export interface DiagMarker { v: 1; nid: string; t: number }

export interface ResolvedFileSettings {
  settings: FileSettings | null
  source: "root" | "page" | "none"
  differ: boolean
  offerMirror: boolean
}

const PREVIEW_SOURCES: readonly PreviewSource[] = ["draft", "published", "pseudo", "keys"]
const RESOLVE_SOURCES: readonly ResolveSource[] = ["draft", "published"]

type JsonObject = Record<string, unknown>

function parseObject(raw: string): JsonObject | null | "empty" {
  if (raw.trim() === "") {
    return "empty"
  }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null
  }
  return value as JsonObject
}

function isObjectId(value: unknown): value is string {
  return typeof value === "string" && OBJECT_ID_PATTERN.test(value)
}

function isString(value: unknown): value is string {
  return typeof value === "string"
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== ""
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && isFinite(value)
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string"
}

export function parseLink(raw: string): ParsedLink {
  const object = parseObject(raw)
  if (object === "empty") {
    return { kind: "none" }
  }
  if (object === null || object.v !== PLUGIN_DATA_VERSION) {
    return { kind: "invalid" }
  }
  if (object.none === true) {
    return { kind: "none" }
  }
  const { id, k, p, src, nid, t } = object
  if (!isObjectId(id) || !isObjectId(p) || !isNonEmptyString(k) || !isString(src) || !isString(nid)) {
    return { kind: "invalid" }
  }
  return { kind: "link", link: { v: 1, id, k, p, src, nid, t: isFiniteNumber(t) ? t : 0 } }
}

export function serializeLink(link: NodeLink): string {
  return JSON.stringify({ v: 1, id: link.id, k: link.k, p: link.p, src: link.src, nid: link.nid, t: link.t })
}

export function createLink(input: { keyId: string; keyName: string; projectId: string; src: string; nodeId: string; now: number }): NodeLink {
  return { v: 1, id: input.keyId, k: input.keyName, p: input.projectId, src: input.src, nid: input.nodeId, t: input.now }
}

export function isTombstone(raw: string): boolean {
  const object = parseObject(raw)
  return object !== null && object !== "empty" && object.v === PLUGIN_DATA_VERSION && object.none === true
}


export function classifyLink(nodeId: string, nid: string, ownPluginDataOverride: boolean | null, textOverridden: boolean): LinkClass {
  if (nid === nodeId) {
    return "ok"
  }
  if (nodeId.charAt(0) === "I") {
    const inherited = ownPluginDataOverride === null
      ? nodeId.endsWith(";" + nid.replace(/^I/, ""))
      : ownPluginDataOverride === false
    if (inherited) {
      return textOverridden ? "inherited_overridden" : "inherited"
    }
  }
  return "copied"
}

export function linkStateOf(parsed: ParsedLink, nodeId: string, ownPluginDataOverride: boolean | null, textOverridden: boolean): LinkState {
  if (parsed.kind === "none") {
    return "none"
  }
  if (parsed.kind === "invalid") {
    return "invalid"
  }
  return classifyLink(nodeId, parsed.link.nid, ownPluginDataOverride, textOverridden)
}

function instanceDepth(nodeId: string): number {
  return nodeId.charAt(0) === "I" ? nodeId.split(";").length - 1 : 0
}

// Write order for canvas batches (§7.14 apply step 2): main components first, then instance sublayers from the
// shallowest nesting level down, so the node an instance takes its text from is always written before the
// instance itself. Stable within a level.
export function mainsFirst<T extends { nodeId: string }>(items: readonly T[]): T[] {
  return items
    .map((item, index) => ({ item, index, depth: instanceDepth(item.nodeId) }))
    .sort((a, b) => a.depth - b.depth || a.index - b.index)
    .map((entry) => entry.item)
}

export function recordOwnership(nodeId: string, nid: string, ownPluginDataOverride: boolean | null): RecordOwnership {
  if (nid === nodeId) {
    return "own"
  }
  return classifyLink(nodeId, nid, ownPluginDataOverride, false) === "inherited" ? "inherited" : "copied"
}

export function relaunchDescription(keyName: string): string {
  return truncateUtf16(RELAUNCH_DESCRIPTION_PREFIX + keyName, RELAUNCH_DESCRIPTION_MAX_CHARS)
}

export function parsePreviewRecord(raw: string): PreviewRecord | null {
  const object = parseObject(raw)
  if (object === null || object === "empty" || object.v !== PLUGIN_DATA_VERSION || object.none === true) {
    return null
  }
  const { nid, previewSrc, characters, autoRename, textOverridden, segments, richLost, lang, source, variationOptionId, appliedAt } = object
  if (
    !isString(nid) || !isString(previewSrc) || !isString(characters) || typeof autoRename !== "boolean" ||
    typeof textOverridden !== "boolean" || !(segments === null || Array.isArray(segments)) || typeof richLost !== "boolean" ||
    !isString(lang) || !PREVIEW_SOURCES.includes(source as PreviewSource) || !isNullableString(variationOptionId) ||
    !isFiniteNumber(appliedAt)
  ) {
    return null
  }
  return {
    v: 1,
    nid,
    previewSrc,
    characters,
    autoRename,
    textOverridden,
    segments: segments as unknown[] | null,
    richLost,
    lang,
    source: source as PreviewSource,
    variationOptionId,
    appliedAt,
  }
}

export function serializePreviewRecord(record: PreviewRecord): string {
  return JSON.stringify({
    v: 1,
    nid: record.nid,
    previewSrc: record.previewSrc,
    characters: record.characters,
    autoRename: record.autoRename,
    textOverridden: record.textOverridden,
    segments: record.segments,
    richLost: record.richLost,
    lang: record.lang,
    source: record.source,
    variationOptionId: record.variationOptionId,
    appliedAt: record.appliedAt,
  })
}

export function ownPreviewRecord(raw: string, nodeId: string): PreviewRecord | null {
  const record = parsePreviewRecord(raw)
  return record !== null && record.nid === nodeId ? record : null
}

export function previewInfoOf(record: PreviewRecord): PreviewInfo {
  return { lang: record.lang, source: record.source, variationOptionId: record.variationOptionId, appliedAt: record.appliedAt }
}

export function parseLangCopy(raw: string): LangCopyMarker | null {
  const object = parseObject(raw)
  if (object === null || object === "empty" || object.v !== PLUGIN_DATA_VERSION || object.none === true) {
    return null
  }
  const { nid, lang, source, variationOptionId, sourceFrameId, createdAt } = object
  if (
    !isNonEmptyString(nid) || !isNonEmptyString(lang) || !RESOLVE_SOURCES.includes(source as ResolveSource) ||
    !isNullableString(variationOptionId) || !isString(sourceFrameId) || !isFiniteNumber(createdAt)
  ) {
    return null
  }
  return { v: 1, nid, lang, source: source as ResolveSource, variationOptionId, sourceFrameId, createdAt }
}

export function serializeLangCopy(marker: LangCopyMarker): string {
  return JSON.stringify({
    v: 1,
    nid: marker.nid,
    lang: marker.lang,
    source: marker.source,
    variationOptionId: marker.variationOptionId,
    sourceFrameId: marker.sourceFrameId,
    createdAt: marker.createdAt,
  })
}

export function isOwnLangCopy(raw: string, frameId: string): boolean {
  const marker = parseLangCopy(raw)
  return marker !== null && marker.nid === frameId
}

export function parseDiagMarker(raw: string): DiagMarker | null {
  const object = parseObject(raw)
  if (object === null || object === "empty" || object.v !== PLUGIN_DATA_VERSION) {
    return null
  }
  const { nid, t } = object
  if (!isString(nid) || !isFiniteNumber(t)) {
    return null
  }
  return { v: 1, nid, t }
}

export function serializeDiagMarker(marker: DiagMarker): string {
  return JSON.stringify({ v: 1, nid: marker.nid, t: marker.t })
}

export function parseFileSettings(raw: string): FileSettings | null {
  const object = parseObject(raw)
  if (object === null || object === "empty" || object.v !== PLUGIN_DATA_VERSION) {
    return null
  }
  const { apiBase, projectId, projectName, updatedAt } = object
  if (!isNonEmptyString(apiBase) || !isObjectId(projectId) || !isString(projectName) || !isFiniteNumber(updatedAt)) {
    return null
  }
  const nullable = (name: string): string | null | undefined => {
    const value = object[name]
    if (value === undefined || value === null) {
      return null
    }
    return typeof value === "string" ? value : undefined
  }
  const flag = (name: string, fallback: boolean): boolean | undefined => {
    const value = object[name]
    if (value === undefined) {
      return fallback
    }
    return typeof value === "boolean" ? value : undefined
  }
  const fileKey = nullable("fileKey")
  const fileUrl = nullable("fileUrl")
  const fileName = nullable("fileName")
  const branchKey = nullable("branchKey")
  const keyTemplate = nullable("keyTemplate")
  const caseStyle = object.caseStyle === undefined ? DEFAULT_FILE_SETTINGS_OPTIONS.caseStyle : object.caseStyle
  const ignoreUnderscoreLayers = flag("ignoreUnderscoreLayers", DEFAULT_FILE_SETTINGS_OPTIONS.ignoreUnderscoreLayers)
  const includeLocked = flag("includeLocked", DEFAULT_FILE_SETTINGS_OPTIONS.includeLocked)
  if (
    fileKey === undefined || fileUrl === undefined || fileName === undefined || branchKey === undefined ||
    keyTemplate === undefined || !CASE_STYLES.includes(caseStyle as CaseStyle) ||
    ignoreUnderscoreLayers === undefined || includeLocked === undefined
  ) {
    return null
  }
  return {
    v: 1,
    apiBase,
    projectId,
    projectName,
    fileKey,
    fileUrl,
    fileName,
    branchKey,
    keyTemplate,
    caseStyle: caseStyle as CaseStyle,
    ignoreUnderscoreLayers,
    includeLocked,
    updatedAt,
  }
}

export function serializeFileSettings(settings: FileSettings): string {
  return JSON.stringify({
    v: 1,
    apiBase: settings.apiBase,
    projectId: settings.projectId,
    projectName: settings.projectName,
    fileKey: settings.fileKey,
    fileUrl: settings.fileUrl,
    fileName: settings.fileName,
    branchKey: settings.branchKey,
    keyTemplate: settings.keyTemplate,
    caseStyle: settings.caseStyle,
    ignoreUnderscoreLayers: settings.ignoreUnderscoreLayers,
    includeLocked: settings.includeLocked,
    updatedAt: settings.updatedAt,
  })
}

export function sameFileSettings(a: FileSettings, b: FileSettings): boolean {
  return serializeFileSettings(a) === serializeFileSettings(b)
}

export function newFileSettings(input: { apiBase: string; projectId: string; projectName: string; now: number }): FileSettings {
  return {
    v: 1,
    apiBase: input.apiBase,
    projectId: input.projectId,
    projectName: input.projectName,
    fileKey: null,
    fileUrl: null,
    fileName: null,
    branchKey: null,
    keyTemplate: DEFAULT_FILE_SETTINGS_OPTIONS.keyTemplate,
    caseStyle: DEFAULT_FILE_SETTINGS_OPTIONS.caseStyle,
    ignoreUnderscoreLayers: DEFAULT_FILE_SETTINGS_OPTIONS.ignoreUnderscoreLayers,
    includeLocked: DEFAULT_FILE_SETTINGS_OPTIONS.includeLocked,
    updatedAt: input.now,
  }
}

export function resolveFileSettings(rootRaw: string, pageRaw: string): ResolvedFileSettings {
  const root = parseFileSettings(rootRaw)
  const page = parseFileSettings(pageRaw)
  if (root === null && page === null) {
    return { settings: null, source: "none", differ: false, offerMirror: false }
  }
  if (root === null) {
    return { settings: page, source: "page", differ: false, offerMirror: false }
  }
  if (page === null) {
    return { settings: root, source: "root", differ: false, offerMirror: true }
  }
  if (sameFileSettings(root, page)) {
    return { settings: root, source: "root", differ: false, offerMirror: false }
  }
  const pageIsNewer = page.updatedAt > root.updatedAt
  return {
    settings: pageIsNewer ? page : root,
    source: pageIsNewer ? "page" : "root",
    differ: true,
    offerMirror: page.updatedAt < root.updatedAt,
  }
}
