import { Button, SearchTextbox, Textbox } from "@create-figma-plugin/ui"
import { h } from "preact"
import { useEffect, useState } from "preact/hooks"
import type { FigmaProject, FigmaProjectsResponse, FigmaUser } from "../../shared/api-types"
import type { ParsedFigmaUrl } from "../../shared/figma-url"
import type { StoredAuth } from "../../shared/messages"
import { userMessage } from "../api/client"
import type { FigmaApi } from "../api/figma-api"
import { FILE_LINK_PLACEHOLDER, FileLinkFeedback } from "../components/file-link"
import { Chip, ErrorNote, Loading, Note, SectionTitle, Small, styles, TextButton } from "../components/ui"
import { readFileLinkInput } from "../state/file-link"
import { groupProjects, permissionLabel } from "../state/projects"

// Project (§7.8): organisations and projects from E8 with permission badges; picking one connects the file
// (settings-save), with the pasted Figma file link when one is given (Phase 2, §7.7). Account and Sign out at
// the bottom.

export interface ProjectScreenProps {
  api: Pick<FigmaApi, "projects">
  auth: StoredAuth
  currentProjectId: string | null
  banner: string | null
  canGoBack: boolean
  // A question to confirm before picking replaces the file's settings (another server's file, §7.7), or null.
  confirmPick?(project: FigmaProject): string | null
  // `link`: the optional "Paste file link" field, saved with the project (null keeps the file's current link).
  onPick(project: FigmaProject, link: ParsedFigmaUrl | null): Promise<void>
  onBack(): void
  onSignOut(): void
  // E8's user (sandbox_expires_at decides whether screenshots can be uploaded, D4).
  onUser?(user: FigmaUser): void
}

export function ProjectScreen(props: ProjectScreenProps) {
  const [data, setData] = useState<FigmaProjectsResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [picking, setPicking] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<{ project: FigmaProject; link: ParsedFigmaUrl | null; question: string } | null>(null)
  const [linkText, setLinkText] = useState("")

  async function load() {
    setError(null)
    try {
      const response = await props.api.projects()
      setData(response)
      props.onUser?.(response.user)
    } catch (caught) {
      setError(userMessage(caught))
    }
  }

  useEffect(() => {
    void load()
  }, [])

  function choose(project: FigmaProject) {
    const input = readFileLinkInput(linkText)
    if (input.kind === "invalid") {
      // The field already says why; nothing is connected until the link is fixed or cleared.
      return
    }
    const link = input.kind === "valid" ? input.link : null
    const question = props.confirmPick?.(project) ?? null
    if (question !== null) {
      setConfirming({ project, link, question })
      return
    }
    void pick(project, link)
  }

  async function pick(project: FigmaProject, link: ParsedFigmaUrl | null) {
    setConfirming(null)
    setPicking(project.id)
    setError(null)
    try {
      await props.onPick(project, link)
    } catch (caught) {
      setError(userMessage(caught))
    } finally {
      setPicking(null)
    }
  }

  const groups = data === null ? [] : groupProjects(data.projects, query)
  return (
    <div style={styles.page}>
      <div style={styles.body}>
        <div style={{ fontSize: "13px", fontWeight: "600", marginBottom: "4px" }}>Choose a ReRune project</div>
        <Small muted>The file remembers this project for everyone who opens it with the plugin.</Small>
        <div style={{ height: "8px" }} />
        {props.banner !== null && <Note tone="warning">{props.banner}</Note>}
        {confirming !== null && (
          <Note
            tone="warning"
            actions={
              <div style={styles.row}>
                <TextButton onClick={() => setConfirming(null)}>Cancel</TextButton>
                <TextButton disabled={picking !== null} onClick={() => void pick(confirming.project, confirming.link)}>
                  Connect here
                </TextButton>
              </div>
            }
          >
            {confirming.question}
          </Note>
        )}
        <div style={{ ...styles.tightStack, margin: "4px 0 8px" }}>
          <Small muted>Figma file link (optional, Share → Copy link). ReRune then shows where each key is used.</Small>
          <Textbox
            value={linkText}
            placeholder={FILE_LINK_PLACEHOLDER}
            disabled={picking !== null}
            spellCheck={false}
            onValueInput={(value) => {
              setLinkText(value)
              setError(null)
            }}
          />
          <FileLinkFeedback text={linkText} />
        </div>
        <ErrorNote message={error} onRetry={data === null ? () => void load() : undefined} />
        {data === null && error === null && <Loading label="Loading projects…" />}
        {data !== null && data.projects.length > 8 && (
          <div style={{ margin: "8px 0" }}>
            <SearchTextbox value={query} placeholder="Filter projects" onValueInput={setQuery} />
          </div>
        )}
        {data !== null && data.projects.length === 0 && (
          <Note tone="info">You aren't a member of any ReRune project yet. Ask a project owner to invite you, or create a project in ReRune.</Note>
        )}
        {groups.map((group) => (
          <div key={group.organisation}>
            <SectionTitle>{group.organisation}</SectionTitle>
            <div style={styles.tightStack}>
              {group.projects.map((project) => {
                const current = project.id === props.currentProjectId
                const canEdit = project.permissions.includes("edit_keys")
                return (
                  <button
                    key={project.id}
                    type="button"
                    disabled={picking !== null}
                    onClick={() => choose(project)}
                    style={{
                      ...styles.card,
                      textAlign: "left",
                      cursor: picking !== null ? "default" : "pointer",
                      background: current ? "var(--figma-color-bg-brand-tertiary)" : "transparent",
                      color: "var(--figma-color-text)",
                      font: "inherit",
                    }}
                  >
                    <div style={styles.row}>
                      <span style={{ ...styles.grow, fontWeight: "600", overflowWrap: "anywhere" }}>{project.name}</span>
                      {current && <Chip tone="info">Connected</Chip>}
                      {picking === project.id && <Small muted>Connecting…</Small>}
                    </div>
                    <div style={styles.wrapRow}>
                      <Small muted>{project.languages.length === 1 ? "1 language" : project.languages.length + " languages"}</Small>
                      {canEdit ? null : <Chip tone="warning">View only</Chip>}
                      {project.permissions.map((permission) => (
                        <Chip key={permission}>{permissionLabel(permission)}</Chip>
                      ))}
                    </div>
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </div>
      <div style={styles.footer}>
        <div style={{ ...styles.grow, ...styles.small }}>
          <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={props.auth.user.email}>
            {props.auth.user.email}
          </div>
          <TextButton onClick={props.onSignOut}>Sign out</TextButton>
        </div>
        {props.canGoBack && (
          <Button secondary onClick={props.onBack}>
            Back
          </Button>
        )}
      </div>
    </div>
  )
}
