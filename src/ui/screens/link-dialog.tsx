import { Button, SearchTextbox, Textbox } from "@create-figma-plugin/ui"
import { h } from "preact"
import { useEffect, useMemo, useRef, useState } from "preact/hooks"
import type { FigmaByNameKey, FigmaKeyRef, FigmaSearchItem } from "../../shared/api-types"
import { SEARCH_DEBOUNCE_MS, SEARCH_PAGE_SIZE } from "../../shared/constants"
import { nameSourceOf } from "../../shared/key-names"
import type { FileSettings, LinkApplyItem, ScannedNode, TextApplyItem } from "../../shared/messages"
import { nodeText } from "../../shared/push-plan"
import { userMessage } from "../api/client"
import type { FigmaApi } from "../api/figma-api"
import type { UiBus } from "../bus"
import { Chip, ErrorGroups, ErrorNote, Note, plural, preview, SectionTitle, Small, styles, TextButton } from "../components/ui"
import { keyNameOf } from "../state/layers"
import {
  createBlockedReason,
  exactTextQueries,
  linkDecision,
  pendingNamesExcept,
  searchPrefill,
  sharedText,
  unlinkTargets,
  type LinkCandidate,
  type LinkDecision,
} from "../state/link"
import { checkNewKeyName, suggesterFor } from "../state/naming"
import { groupErrors, mainsFirst, removeLinksBatched, runBatched, type ErrorGroup } from "../state/ops"
import type { Workspace, WorkspaceState } from "../state/workspace"

// Link dialog (§7.8, §7.11): exact-text matches (E11) first, search (E10, debounced), "Create new key" with a
// suggested, validated name (created on push), and the Use ReRune text / Keep layer text choice.

export interface LinkDialogProps {
  nodes: ScannedNode[]
  projectId: string
  mainLanguage: string
  readOnly: boolean
  sample: readonly string[]
  settings: FileSettings | null
  initialKey: FigmaKeyRef | null
  api: Pick<FigmaApi, "keysByName" | "searchKeys" | "resolveKeys">
  bus: UiBus
  workspace: Workspace
  state: WorkspaceState
  onClose(changed: boolean): void
  onSelect(nodeIds: string[]): void
}

const NAME_CHECK_DEBOUNCE_MS = 400
const MATCH_LABELS = { exact_key: "Same name", exact_text: "Same text", partial: "" } as const

export function LinkDialog(props: LinkDialogProps) {
  const nodeIds = useMemo(() => props.nodes.map((node) => node.nodeId), [props.nodes])
  const text = sharedText(props.nodes)
  const [exact, setExact] = useState<{ loading: boolean; candidates: LinkCandidate[] }>({ loading: true, candidates: [] })
  const [query, setQuery] = useState(() => searchPrefill(props.nodes.length > 0 ? nodeText(props.nodes[0]) : ""))
  const [results, setResults] = useState<FigmaSearchItem[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [decision, setDecision] = useState<{ key: LinkCandidate; value: LinkDecision } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errors, setErrors] = useState<ErrorGroup[]>([])
  const pendingName = props.nodes.map((node) => props.state.pending.get(node.nodeId)).find((name) => name !== undefined) ?? null
  const suggestion = useMemo(() => {
    if (props.nodes.length === 0) {
      return ""
    }
    const others = pendingNamesExcept(props.state.pending, nodeIds)
    return suggesterFor(props.sample, props.settings, others).suggest(nameSourceOf(props.nodes[0]))
  }, [props.nodes])
  const [newName, setNewName] = useState(pendingName ?? suggestion)
  const [nameLookup, setNameLookup] = useState<{ name: string; key: FigmaByNameKey | null } | null>(null)
  const searchGeneration = useRef(0)

  // Exact-text matches (D40): E11 compares the normalised text with each key's main value byte for byte, so a
  // match's main text is the queried text.
  useEffect(() => {
    let alive = true
    const texts = exactTextQueries(props.nodes)
    if (texts.length === 0) {
      setExact({ loading: false, candidates: [] })
      return
    }
    props.api
      .keysByName(props.projectId, { texts })
      .then((response) => {
        if (!alive) return
        const candidates = new Map<string, LinkCandidate>()
        for (const match of response.text_matches) {
          for (const key of match.keys) {
            if (!candidates.has(key.id)) {
              candidates.set(key.id, { id: key.id, key: key.key, main_content: { value: match.text } })
            }
          }
        }
        setExact({ loading: false, candidates: [...candidates.values()] })
      })
      .catch(() => {
        if (alive) setExact({ loading: false, candidates: [] })
      })
    return () => {
      alive = false
    }
  }, [props.nodes])

  // A key handed in by the push results ("Link to existing {key}" for duplicate_key).
  useEffect(() => {
    if (props.initialKey === null) {
      return
    }
    const initial = props.initialKey
    let alive = true
    const load = async (): Promise<LinkCandidate> => {
      if (props.mainLanguage === "") {
        return { ...initial, main_content: null }
      }
      const response = await props.api.resolveKeys(props.projectId, { key_ids: [initial.id], languages: [props.mainLanguage], source: "draft", variation_option_id: null })
      const value = response.keys[0]?.values.find((entry) => entry.lang === props.mainLanguage)
      return { ...initial, main_content: value !== undefined && value.present ? value.content : null }
    }
    load()
      .then((candidate) => {
        if (alive) choose(candidate)
      })
      .catch((caught: unknown) => {
        if (alive) setError(userMessage(caught))
      })
    return () => {
      alive = false
    }
  }, [props.initialKey])

  async function search(q: string, after: string | null) {
    const mine = ++searchGeneration.current
    setSearching(true)
    setSearchError(null)
    try {
      const response = await props.api.searchKeys(props.projectId, { q, cursor: after, limit: SEARCH_PAGE_SIZE })
      if (mine !== searchGeneration.current) return
      setResults((current) => (after === null ? response.items : current.concat(response.items)))
      setCursor(response.has_more ? response.next_cursor : null)
    } catch (caught) {
      if (mine === searchGeneration.current) setSearchError(userMessage(caught))
    } finally {
      if (mine === searchGeneration.current) setSearching(false)
    }
  }

  useEffect(() => {
    const timer = setTimeout(() => void search(query, null), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query])

  const trimmedName = newName.trim()
  useEffect(() => {
    if (trimmedName === "" || trimmedName.length > 200) {
      setNameLookup(null)
      return
    }
    let alive = true
    const timer = setTimeout(() => {
      props.api
        .keysByName(props.projectId, { names: [trimmedName] })
        .then((response) => {
          if (alive) setNameLookup({ name: trimmedName, key: response.keys.find((key) => key.key === trimmedName) ?? null })
        })
        .catch(() => {
          if (alive) setNameLookup(null)
        })
    }, NAME_CHECK_DEBOUNCE_MS)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [trimmedName])

  const takenKey = nameLookup !== null && nameLookup.name === trimmedName ? nameLookup.key : null
  const sameText = (nodeId: string) => {
    const node = props.state.result?.nodes.find((entry) => entry.nodeId === nodeId)
    return node !== undefined && text !== null && nodeText(node) === text
  }
  const duplicate = pendingNamesExcept(props.state.pending, nodeIds, sameText).has(trimmedName)
  const nameCheck = checkNewKeyName(newName, { taken: takenKey !== null || props.sample.includes(trimmedName), duplicate })

  function choose(key: LinkCandidate) {
    setError(null)
    setErrors([])
    const value = linkDecision(props.nodes, key, props.projectId)
    if (value.kind === "direct" && value.note === null) {
      void write(value.links, [])
      return
    }
    setDecision({ key, value })
  }

  async function write(links: LinkApplyItem[], texts: TextApplyItem[]) {
    setBusy(true)
    setError(null)
    try {
      const linked = await runBatched(props.bus, mainsFirst(links), (requestId, batch) => ({ type: "link-apply", requestId, items: batch }))
      const written = texts.length > 0 ? await runBatched(props.bus, mainsFirst(texts), (requestId, batch) => ({ type: "text-apply", requestId, items: batch })) : { done: 0, errors: [] }
      const all = [...linked.errors, ...written.errors]
      props.workspace.setPending(nodeIds, null)
      if (all.length === 0) {
        props.onClose(true)
        return
      }
      setDecision(null)
      setErrors(groupErrors(all))
    } catch (caught) {
      setError(userMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  async function unlink() {
    setBusy(true)
    setError(null)
    try {
      const removed = await removeLinksBatched(props.bus, unlinkTargets(props.nodes))
      if (removed.errors.length === 0) {
        props.onClose(true)
        return
      }
      setErrors(groupErrors(removed.errors))
    } catch (caught) {
      setError(userMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  function markForCreation() {
    props.workspace.setPending(nodeIds, trimmedName)
    props.onClose(false)
  }

  const single = props.nodes.length === 1 ? props.nodes[0] : null
  const linked = unlinkTargets(props.nodes)
  const createBlocked = createBlockedReason(props.nodes)
  const currentKey = single !== null && single.link !== null ? keyNameOf(single, props.state.remote) : null

  if (decision !== null) {
    const value = decision.value
    return (
      <div style={styles.page}>
        <div style={{ ...styles.body, ...styles.stack }}>
          <div style={{ fontWeight: "600" }}>Link to {decision.key.key}</div>
          {value.kind === "direct" && value.note !== null && <Note tone="info">{value.note}</Note>}
          {value.kind === "ask" && (
            <div style={styles.stack}>
              <Small>
                {props.nodes.length === 1 ? "The layer text differs from ReRune." : plural(value.differing, "layer differs", "layers differ") + " from the text in ReRune."}
              </Small>
              <div style={styles.card}>
                <Small muted>Layer</Small>
                <div style={styles.clamp}>{preview(props.nodes.map(nodeText).find((entry) => entry !== value.remoteText) ?? "", 300)}</div>
                <Small muted>ReRune</Small>
                <div style={styles.clamp}>{preview(value.remoteText, 300)}</div>
              </div>
              <Small muted>Keep layer text links the layer and pushes its text to ReRune later as a draft.</Small>
            </div>
          )}
          <ErrorNote message={error} />
        </div>
        <div style={{ ...styles.footer, justifyContent: "flex-end" }}>
          <Button secondary disabled={busy} onClick={() => setDecision(null)}>
            Back
          </Button>
          {value.kind === "ask" ? (
            <div style={styles.row}>
              <Button secondary disabled={busy || props.readOnly} onClick={() => void write(value.keep, [])}>
                Keep layer text
              </Button>
              <Button disabled={busy || props.readOnly} loading={busy} onClick={() => void write(value.use.links, value.use.texts)}>
                Use ReRune text
              </Button>
            </div>
          ) : (
            <Button disabled={busy || props.readOnly} loading={busy} onClick={() => void write(value.links, [])}>
              Link
            </Button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div style={styles.page}>
      <div style={{ ...styles.row, padding: "8px 12px", borderBottom: "1px solid var(--figma-color-border)" }}>
        <div style={{ ...styles.grow, fontWeight: "600" }}>{single !== null ? "Link layer" : "Link " + props.nodes.length + " layers"}</div>
        <TextButton onClick={() => props.onSelect(nodeIds)}>Select on canvas</TextButton>
        <TextButton onClick={() => props.onClose(false)}>Close</TextButton>
      </div>
      <div style={styles.body}>
        <div style={styles.card}>
          <div style={styles.clamp}>{text !== null ? preview(text, 300) : plural(props.nodes.length, "layer", "layers") + " with different texts"}</div>
          {single !== null && <Small muted>{single.name}{single.frameName !== null ? " · " + single.frameName : ""}</Small>}
          {currentKey !== null && (
            <div style={styles.wrapRow}>
              <Small>Linked to</Small>
              <span style={styles.mono}>{currentKey}</span>
              {single?.linkState === "inherited" && <Chip>From main component</Chip>}
              {single?.linkState === "copied" && <Chip tone="warning">Copied</Chip>}
              {single?.linkState === "inherited_overridden" && <Chip tone="warning">Text overridden</Chip>}
            </div>
          )}
          {single?.linkState === "invalid" && <Note tone="danger">This layer has a broken ReRune link. Unlink it, then link it again.</Note>}
          {linked.length > 0 && (
            <div>
              <TextButton danger disabled={busy || props.readOnly} onClick={() => void unlink()}>
                {linked.length === 1 ? "Unlink" : "Unlink " + linked.length + " layers"}
              </TextButton>
            </div>
          )}
        </div>
        <ErrorNote message={error} />
        <ErrorGroups groups={errors} onSelect={props.onSelect} />

        {(exact.loading || exact.candidates.length > 0) && <SectionTitle>Same text in ReRune</SectionTitle>}
        {exact.loading && <Small muted>Looking for keys with the same text…</Small>}
        <div style={styles.tightStack}>
          {exact.candidates.map((candidate) => (
            <div key={candidate.id} style={{ ...styles.row, ...styles.card, flexDirection: "row" }}>
              <span style={{ ...styles.grow, ...styles.mono }}>{candidate.key}</span>
              <Button disabled={busy || props.readOnly} onClick={() => choose(candidate)}>
                Link to {candidate.key.length > 24 ? candidate.key.slice(0, 23) + "…" : candidate.key}
              </Button>
            </div>
          ))}
        </div>

        <SectionTitle>Search keys</SectionTitle>
        <SearchTextbox value={query} placeholder="Key name or text" onValueInput={setQuery} />
        <div style={{ height: "6px" }} />
        <ErrorNote message={searchError} onRetry={() => void search(query, null)} />
        <div style={styles.tightStack}>
          {results.map((item) => (
            <button
              key={item.id}
              type="button"
              disabled={busy || props.readOnly}
              onClick={() => choose({ id: item.id, key: item.key, main_content: item.main_content })}
              style={{ ...styles.card, textAlign: "left", cursor: "pointer", background: "transparent", color: "var(--figma-color-text)", font: "inherit" }}
            >
              <div style={styles.wrapRow}>
                <span style={{ ...styles.grow, ...styles.mono }}>{item.key}</span>
                {MATCH_LABELS[item.match] !== "" && <Chip tone="info">{MATCH_LABELS[item.match]}</Chip>}
                {item.max_length !== null && <Chip>max {item.max_length}</Chip>}
              </div>
              <div style={{ ...styles.clamp, ...styles.small, ...styles.muted }}>
                {item.main_content.message !== undefined && item.main_content.message !== null ? "Plural or ICU message" : preview(item.main_content.value, 200) || "(no source text)"}
              </div>
            </button>
          ))}
        </div>
        {searching && <Small muted>Searching…</Small>}
        {!searching && results.length === 0 && searchError === null && <Small muted>No keys found.</Small>}
        {cursor !== null && !searching && (
          <Button fullWidth secondary onClick={() => void search(query, cursor)}>
            More results
          </Button>
        )}

        <SectionTitle>Create new key</SectionTitle>
        {createBlocked !== null ? (
          <Small muted>{createBlocked}</Small>
        ) : text === null ? (
          <Small muted>Select layers with the same text to create one key for them.</Small>
        ) : (
          <div style={styles.stack}>
            <Textbox value={newName} onValueInput={setNewName} placeholder="key_name" spellCheck={false} />
            {nameCheck.issues.map((issue) => (
              <Small key={issue} style={{ color: "var(--figma-color-text-danger)" }}>
                {issue}
              </Small>
            ))}
            {takenKey !== null && takenKey.type === "key" && (
              <div>
                <Button secondary disabled={busy || props.readOnly} onClick={() => choose({ id: takenKey.id, key: takenKey.key, main_content: takenKey.main_content })}>
                  Link to existing key {takenKey.key}
                </Button>
              </div>
            )}
            {nameCheck.warnings.map((warning) => (
              <Small key={warning} muted>
                {warning}
              </Small>
            ))}
            <Small muted>The key is created in ReRune when you push. Until then nothing is sent.</Small>
            <div style={styles.row}>
              <Button disabled={props.readOnly || nameCheck.issues.length > 0} onClick={markForCreation}>
                {pendingName !== null ? "Update new key" : "Create on push"}
              </Button>
              {pendingName !== null && (
                <TextButton
                  onClick={() => {
                    props.workspace.setPending(nodeIds, null)
                    props.onClose(false)
                  }}
                >
                  Don't create
                </TextButton>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
