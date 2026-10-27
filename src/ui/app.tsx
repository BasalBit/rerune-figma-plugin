import { Container, Muted, Text, useWindowResize, VerticalSpace } from "@create-figma-plugin/ui"
import { Fragment, h } from "preact"
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks"
import type { FigmaKeyRef, FigmaProject, FigmaProjectDetail } from "../shared/api-types"
import { DESIGN_UI_MAX_SIZE, DESIGN_UI_MIN_SIZE } from "../shared/constants"
import type { FileSettings, MainToUiOf, ScannedNode, Scope, StoredAuth } from "../shared/messages"
import { ApiError, createApiClient, userMessage, type FetchLike } from "./api/client"
import { createFigmaApi, type FigmaApi } from "./api/figma-api"
import { browserEnvironment, createUiBus, type UiBus } from "./bus"
import { copyText } from "./clipboard"
import { Nav } from "./components/nav"
import { ErrorGroups, GlobalStyle, Loading, Note, styles, TextButton } from "./components/ui"
import { runNetworkCheck } from "./diagnostics"
import { DiagnosticsScreen } from "./screens/diagnostics"
import { InspectScreen } from "./screens/inspect"
import { LayersScreen } from "./screens/layers"
import { LinkDialog } from "./screens/link-dialog"
import { PairingScreen } from "./screens/pairing"
import { ProjectScreen } from "./screens/project-picker"
import { PreviewScreen } from "./screens/preview"
import { PushScreen } from "./screens/push"
import { SettingsScreen } from "./screens/settings"
import { SignInScreen } from "./screens/sign-in"
import { SignedInScreen } from "./screens/signed-in"
import { connectedSettings, initialView, isWorkspaceScreen, navigate, type AppView, type NavContext, type NavEvent, type Screen } from "./state/navigation"
import { createScanRunner, groupErrors, layerCount, LONG_OP_IDLE_MS, runOp, singleFlight, type ErrorGroup } from "./state/ops"
import { createPairingFlow, type PairingFlow, type PairingState } from "./state/pairing"
import { previewStatus, resetOutcome } from "./state/preview"
import { cacheEntriesFromResolved } from "./state/remote"
import { SESSION_ENDED_NOTICE, signOut, usableAuth } from "./state/session"
import { API_BASE_MISMATCH, connectProject, parsePrefs, parseSettingsReport, type Prefs, type SettingsStatus } from "./state/settings"
import { useStore } from "./state/use-store"
import { createWorkspace } from "./state/workspace"

type Init = MainToUiOf<"init">

const COPIED_RESET_MS = 1500
const browserFetch: FetchLike = (url, request) => fetch(url, request)

function createApi(init: Init, getToken: () => string | null, onUnauthorized: () => void): FigmaApi {
  return createFigmaApi(createApiClient({ apiBase: init.apiBase, fetch: browserFetch, getToken, onUnauthorized }))
}

// Dev Mode inspect panel (Phase 1 minimum): linked key names with Copy; development builds add Diagnostics.
function InspectApp(props: { bus: UiBus; init: Init }) {
  const [selection, setSelection] = useState<MainToUiOf<"inspect-selection"> | null>(null)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const [view, setView] = useState<"inspect" | "diagnostics">("inspect")
  const development = props.init.env === "development"
  const api = useMemo(() => createApi(props.init, () => props.init.auth?.token ?? null, () => {}), [])

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
    return (
      <DiagnosticsScreen
        bus={props.bus}
        editorType="dev"
        env={props.init.env}
        onBack={() => setView("inspect")}
        networkCheck={() => runNetworkCheck(() => api.meta(), props.init.apiBase)}
      />
    )
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

interface Banner { tone: "good" | "info" | "warning"; message: string; errors: ErrorGroup[] }

// Design mode (§7.8): sign-in, project, and the Layers / Push / Preview / Settings workspace.
function DesignApp(props: { bus: UiBus; init: Init }) {
  const { bus, init } = props
  const authRef = useRef<StoredAuth | null>(usableAuth(init.auth, init.apiBase))
  const [auth, setAuthState] = useState<StoredAuth | null>(authRef.current)
  const [settings, setSettings] = useState<FileSettings | null>(init.fileSettings)
  const [status, setStatus] = useState<SettingsStatus | null>(null)
  const [prefs, setPrefs] = useState<Prefs>(() => parsePrefs(init.prefs))
  const [project, setProject] = useState<FigmaProjectDetail | null>(null)
  const projectRef = useRef<FigmaProjectDetail | null>(null)
  const [projectError, setProjectError] = useState<string | null>(null)
  const [selectionCount, setSelectionCount] = useState(init.selectionCount)
  const pageRef = useRef(init.pageId)
  const contextRef = useRef<NavContext>({ apiBase: init.apiBase, settings })
  contextRef.current = { apiBase: init.apiBase, settings }
  const [view, setView] = useState<AppView>(() => initialView(authRef.current, contextRef.current))
  const [diagnosticsReturn, setDiagnosticsReturn] = useState<Screen>("sign-in")
  const [link, setLink] = useState<{ nodes: ScannedNode[]; key: FigmaKeyRef | null } | null>(null)
  const [pairing, setPairing] = useState<{ flow: PairingFlow; state: PairingState } | null>(null)
  const [notMeBusy, setNotMeBusy] = useState(false)
  const [editedPrompt, setEditedPrompt] = useState<{ scope: Scope; nodeIds: string[] } | null>(null)
  const [resetting, setResetting] = useState(false)
  const [applyingPreview, setApplyingPreview] = useState(false)
  const [banner, setBanner] = useState<Banner | null>(null)
  const signedOutRef = useRef<() => void>(() => {})

  const api = useMemo(() => createApi(init, () => authRef.current?.token ?? null, () => signedOutRef.current()), [])
  const workspace = useMemo(
    () => createWorkspace({ scanner: createScanRunner(bus), api, project: () => projectRef.current }),
    [],
  )
  const space = useStore(workspace.store)

  const onResize = useCallback((size: { width: number; height: number }) => bus.send({ type: "resize", width: size.width, height: size.height }), [bus])
  useWindowResize(onResize, {
    minWidth: DESIGN_UI_MIN_SIZE.width,
    minHeight: DESIGN_UI_MIN_SIZE.height,
    maxWidth: DESIGN_UI_MAX_SIZE.width,
    maxHeight: DESIGN_UI_MAX_SIZE.height,
  })

  function go(event: NavEvent) {
    setView((current) => navigate(current, event, contextRef.current))
  }

  function setAuth(next: StoredAuth | null) {
    authRef.current = next
    setAuthState(next)
  }

  function setActiveProject(next: FigmaProjectDetail | null) {
    projectRef.current = next
    setProject(next)
  }

  signedOutRef.current = () => {
    if (authRef.current === null) {
      return
    }
    bus.send({ type: "auth-clear", apiBase: init.apiBase })
    setAuth(null)
    setActiveProject(null)
    setLink(null)
    workspace.clear(true)
    go({ type: "signed-out", notice: SESSION_ENDED_NOTICE })
  }

  async function refreshStatus(): Promise<void> {
    try {
      const report = await bus.request((requestId) => ({ type: "diagnostics-read", requestId, test: "T7-settings" }), {
        done: (message) => (message.type === "diagnostics-result" ? message.report : undefined),
      })
      const next = parseSettingsReport(report)
      if (next !== null) {
        setStatus(next)
        setSettings(next.settings)
      }
    } catch {
      // The status only adds the Repair/mirror offers; init's settings stay in use.
    }
  }

  const loadingProject = useRef<string | null>(null)

  async function loadProject(projectId: string): Promise<void> {
    setProjectError(null)
    loadingProject.current = projectId
    try {
      const detail = await api.project(projectId)
      if (authRef.current !== null && loadingProject.current === projectId) {
        setActiveProject(detail)
      }
    } catch (caught) {
      if (caught instanceof ApiError && (caught.status === 403 || caught.status === 404)) {
        setProjectError("This file's ReRune project isn't available to " + (authRef.current?.user.email ?? "this account") + ". Choose a project.")
        go({ type: "change-project" })
      } else if (!(caught instanceof ApiError && caught.status === 401)) {
        setProjectError(userMessage(caught))
      }
    } finally {
      if (loadingProject.current === projectId) {
        loadingProject.current = null
      }
    }
  }

  // Loads the project detail (E9) unless it is already loaded or loading.
  function ensureProject(projectId: string): void {
    if (projectRef.current?.id !== projectId && loadingProject.current !== projectId) {
      setActiveProject(null)
      void loadProject(projectId)
    }
  }

  // Selection and page changes (§7.5). Another page may carry other settings (page mirror, §7.7).
  useEffect(() => {
    void refreshStatus()
    return bus.on("selection-changed", (message) => {
      setSelectionCount(message.selectionCount)
      if (message.pageId !== pageRef.current) {
        pageRef.current = message.pageId
        workspace.clear()
        void refreshStatus()
      }
    })
  }, [])

  const usable = connectedSettings({ apiBase: init.apiBase, settings })
  useEffect(() => {
    if (auth !== null && usable !== null) {
      ensureProject(usable.projectId)
    }
  }, [auth, usable?.projectId])

  // First look at the workspace: scan the selection (relaunch "open" lands here too, §7.4).
  useEffect(() => {
    if (project !== null && workspace.store.get().status === "idle" && workspace.store.get().scope === "selection") {
      void workspace.scan("selection")
    }
  }, [project?.id])

  // Keep the codegen cache fresh with the key names the Design mode resolved (§7.17).
  useEffect(() => {
    if (project !== null && space.remoteStatus === "ready" && space.resolved.size > 0) {
      const entries = cacheEntriesFromResolved(space.resolved, project.main_language)
      if (entries.length > 0) {
        bus.send({ type: "cache-save", projectId: project.id, entries })
      }
    }
  }, [space.resolved])

  function updatePrefs(patch: Partial<Prefs>) {
    setPrefs((current) => ({ ...current, ...patch }))
    bus.send({ type: "prefs-save", prefs: patch as Record<string, unknown> })
  }

  async function saveSettings(next: FileSettings): Promise<void> {
    const result = await runOp(bus, (requestId) => ({ type: "settings-save", requestId, settings: next }))
    if (!result.ok) {
      throw new Error(result.errors[0]?.message ?? "The settings couldn't be saved.")
    }
    setSettings(next)
    await refreshStatus()
  }

  async function pickProject(picked: FigmaProject): Promise<void> {
    const next = connectProject(settings, picked, init.apiBase, Date.now())
    const changed = settings?.projectId !== picked.id || settings?.apiBase !== init.apiBase
    await saveSettings(next)
    contextRef.current = { apiBase: init.apiBase, settings: next }
    if (changed) {
      workspace.clear(true)
    }
    setProjectError(null)
    ensureProject(picked.id)
    go({ type: "project-connected" })
  }

  function startSignIn() {
    pairing?.flow.dispose()
    const flow = createPairingFlow({
      api,
      apiBase: init.apiBase,
      dashboardBase: init.dashboardBase,
      env: init.env,
      openExternal: (url) => bus.send({ type: "open-external", url }),
      saveAuth: (next) => bus.send({ type: "auth-save", auth: next }),
    })
    setPairing({ flow, state: flow.getState() })
    flow.subscribe((state) => {
      setPairing({ flow, state })
      if (state.kind === "approved") {
        setAuth(state.auth)
        go({ type: "pairing-approved", auth: state.auth })
      }
    })
    go({ type: "start-sign-in" })
    void flow.start()
  }

  function cancelSignIn() {
    pairing?.flow.cancel()
    pairing?.flow.dispose()
    setPairing(null)
    go({ type: "pairing-cancelled" })
  }

  async function signOutNow(event: "not-me" | "signed-out") {
    const current = authRef.current
    if (current === null) {
      return
    }
    setNotMeBusy(true)
    await signOut({ logout: (token) => api.logout(token), send: (message) => bus.send(message) }, current)
    setNotMeBusy(false)
    setAuth(null)
    setActiveProject(null)
    setLink(null)
    workspace.clear(true)
    go(event === "not-me" ? { type: "not-me" } : { type: "signed-out", notice: null })
  }

  // Preview reset (§7.14): edited layers get the Keep/Restore question; override_kept is reported. One reset at a
  // time: Nav, Push and the edited prompt share it, so a double click never starts overlapping resets.
  async function runResetPreviews(scope: Scope, nodeIds?: string[], edited?: "keep" | "restore"): Promise<void> {
    const result = await runOp(bus, (requestId) => ({ type: "preview-reset", requestId, scope, nodeIds, edited }), LONG_OP_IDLE_MS)
    const outcome = resetOutcome(result.done, result.errors)
    if (outcome.edited.length > 0 && edited === undefined) {
      setEditedPrompt({ scope, nodeIds: outcome.edited })
    } else {
      setEditedPrompt(null)
    }
    const parts = ["Reset " + layerCount(outcome.done) + "."]
    if (outcome.overrideKept > 0) {
      parts.push(outcome.overrideKept === 1 ? "1 instance keeps a text override after reset." : outcome.overrideKept + " instances keep a text override after reset.")
    }
    setBanner({ tone: outcome.otherErrors.length > 0 || outcome.overrideKept > 0 ? "warning" : "good", message: parts.join(" "), errors: groupErrors(outcome.otherErrors) })
    await workspace.scan()
  }

  const resetWork = useRef(runResetPreviews)
  resetWork.current = runResetPreviews
  const resetFlight = useMemo(() => singleFlight((scope: Scope, nodeIds?: string[], edited?: "keep" | "restore") => resetWork.current(scope, nodeIds, edited), setResetting), [])

  function resetPreviews(scope: Scope, nodeIds?: string[], edited?: "keep" | "restore"): Promise<void> {
    return resetFlight.run(scope, nodeIds, edited)
  }

  function selectNodes(nodeIds: string[]) {
    if (nodeIds.length > 0) {
      bus.send({ type: "select-nodes", nodeIds })
    }
  }

  function openExternal(url: string) {
    bus.send({ type: "open-external", url })
  }

  function openDiagnostics() {
    setDiagnosticsReturn(view.screen)
    go({ type: "open", screen: "diagnostics" })
  }

  const readOnly = settings !== null && settings.apiBase !== init.apiBase
  const screen = view.screen

  if (screen === "diagnostics") {
    return (
      <DiagnosticsScreen
        bus={bus}
        editorType="figma"
        env={init.env}
        onBack={() => setView((current) => ({ ...current, screen: diagnosticsReturn }))}
        networkCheck={() => runNetworkCheck(() => api.meta(), init.apiBase)}
      />
    )
  }

  if (screen === "sign-in" || auth === null) {
    if (screen === "pairing" && pairing !== null) {
      return <PairingScreen state={pairing.state} onCancel={cancelSignIn} onReopen={() => pairing.flow.reopen()} onRestart={startSignIn} />
    }
    return (
      <SignInScreen
        notice={view.notice}
        version={init.pluginVersion}
        onSignIn={startSignIn}
        onCreateAccount={() => openExternal(init.dashboardBase + "/register")}
        onDiagnostics={openDiagnostics}
      />
    )
  }

  if (screen === "signed-in" && view.signedIn !== null) {
    return (
      <SignedInScreen
        auth={view.signedIn}
        busy={notMeBusy}
        onContinue={() => {
          pairing?.flow.dispose()
          setPairing(null)
          go({ type: "continue" })
        }}
        onNotMe={() => void signOutNow("not-me")}
      />
    )
  }

  if (screen === "project" || screen === "pairing" || screen === "signed-in") {
    return (
      <ProjectScreen
        api={api}
        auth={auth}
        currentProjectId={usable?.projectId ?? null}
        banner={projectError ?? (readOnly ? API_BASE_MISMATCH + " Choose a project on this server to connect the file here." : null)}
        canGoBack={usable !== null && project !== null}
        onPick={pickProject}
        onBack={() => go({ type: "open", screen: "layers" })}
        onSignOut={() => void signOutNow("signed-out")}
      />
    )
  }

  if (!isWorkspaceScreen(screen)) {
    return null
  }

  if (project === null) {
    return (
      <div style={styles.page}>
        <div style={styles.body}>
          {projectError !== null ? (
            <Note tone="warning" actions={<TextButton onClick={() => usable !== null && void loadProject(usable.projectId)}>Try again</TextButton>}>
              {projectError}
            </Note>
          ) : (
            <Loading label={"Loading " + (usable?.projectName ?? "project") + "…"} />
          )}
        </div>
      </div>
    )
  }

  if (link !== null) {
    return (
      <LinkDialog
        nodes={link.nodes}
        projectId={project.id}
        mainLanguage={project.main_language}
        readOnly={readOnly}
        sample={project.key_name_sample}
        settings={usable}
        initialKey={link.key}
        api={api}
        bus={bus}
        workspace={workspace}
        state={space}
        onSelect={selectNodes}
        onClose={(changed) => {
          setLink(null)
          if (changed) {
            void workspace.scan()
          }
        }}
      />
    )
  }

  const previewing = previewStatus(space.result?.nodes ?? [])
  return (
    <div style={styles.page}>
      <Nav
        active={screen}
        projectName={project.name}
        selectionCount={selectionCount}
        previewStatus={previewing}
        onOpen={(next) => go({ type: "open", screen: next })}
        onChangeProject={() => go({ type: "change-project" })}
        resetDisabled={resetting || applyingPreview}
        onResetPreview={() => void resetPreviews("page").catch((caught: unknown) => setBanner({ tone: "warning", message: userMessage(caught), errors: [] }))}
      />
      {editedPrompt !== null && (
        <div style={{ padding: "8px 12px 0" }}>
          <Note
            tone="warning"
            actions={
              <div style={styles.row}>
                <TextButton disabled={resetting} onClick={() => void resetPreviews(editedPrompt.scope, editedPrompt.nodeIds, "keep")}>
                  Keep current text
                </TextButton>
                <TextButton disabled={resetting} onClick={() => void resetPreviews(editedPrompt.scope, editedPrompt.nodeIds, "restore")}>
                  Restore original
                </TextButton>
              </div>
            }
          >
            {layerCount(editedPrompt.nodeIds.length)} {editedPrompt.nodeIds.length === 1 ? "was" : "were"} edited during preview.
          </Note>
        </div>
      )}
      {banner !== null && (
        <div style={{ padding: "8px 12px 0", ...styles.tightStack }}>
          <Note tone={banner.tone} actions={<TextButton onClick={() => setBanner(null)}>Dismiss</TextButton>}>
            {banner.message}
          </Note>
          <ErrorGroups groups={banner.errors} onSelect={selectNodes} />
        </div>
      )}
      <div style={{ flex: "1", minHeight: "0", display: "flex", flexDirection: "column" }}>
        {screen === "layers" && (
          <LayersScreen
            workspace={workspace}
            state={space}
            projectId={project.id}
            readOnly={readOnly}
            api={api}
            bus={bus}
            onOpenLink={(nodes) => setLink({ nodes, key: null })}
            onSelect={selectNodes}
          />
        )}
        {screen === "push" && (
          <PushScreen
            workspace={workspace}
            state={space}
            project={project}
            settings={usable}
            prefs={prefs}
            readOnly={readOnly}
            api={api}
            bus={bus}
            dashboardBase={init.dashboardBase}
            onOpenLink={(nodes, key) => setLink({ nodes, key })}
            onSelect={selectNodes}
            onOpenExternal={openExternal}
            resetting={resetting}
            onResetPreviews={(scope, nodeIds) => resetPreviews(scope, nodeIds)}
            onAvailableKeys={(availableKeys) => setActiveProject({ ...project, available_keys: availableKeys })}
          />
        )}
        {screen === "preview" && (
          <PreviewScreen
            workspace={workspace}
            state={space}
            project={project}
            prefs={prefs}
            readOnly={readOnly}
            api={api}
            bus={bus}
            onPrefs={updatePrefs}
            onSelect={selectNodes}
            resetting={resetting}
            onApplying={setApplyingPreview}
            onReset={(scope, nodeIds) => resetPreviews(scope, nodeIds)}
          />
        )}
        {screen === "settings" && (
          <SettingsScreen
            settings={usable}
            status={status}
            sample={project.key_name_sample}
            prefs={prefs}
            auth={auth}
            version={init.pluginVersion}
            readOnly={readOnly}
            onSave={saveSettings}
            onPrefs={updatePrefs}
            onChangeProject={() => go({ type: "change-project" })}
            onDiagnostics={openDiagnostics}
            onSignOut={() => void signOutNow("signed-out")}
          />
        )}
      </div>
    </div>
  )
}

export function App() {
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
  return (
    <Fragment>
      <GlobalStyle />
      {init.editorType === "dev" ? <InspectApp bus={bus} init={init} /> : <DesignApp bus={bus} init={init} />}
    </Fragment>
  )
}
