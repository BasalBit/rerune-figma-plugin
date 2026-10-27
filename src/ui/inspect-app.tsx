import { h } from "preact"
import { useEffect, useMemo, useRef, useState } from "preact/hooks"
import type { CodegenPlatform } from "../codegen/snippets"
import type { FigmaProjectDetail, FigmaResolveSource } from "../shared/api-types"
import type { FileSettings, MainToUiOf, StoredAuth } from "../shared/messages"
import { createBrowserApi } from "./api/browser"
import { ApiError, userMessage } from "./api/client"
import type { UiBus } from "./bus"
import { copyText } from "./clipboard"
import { runNetworkCheck } from "./diagnostics"
import { DiagnosticsScreen } from "./screens/diagnostics"
import { InspectNotice, InspectScreen } from "./screens/inspect"
import { PairingScreen } from "./screens/pairing"
import { SignInScreen } from "./screens/sign-in"
import { SignedInScreen } from "./screens/signed-in"
import {
  createInspectLoader,
  INITIAL_INSPECT_VIEW,
  INSPECT_DESCRIPTION,
  inspectAccess,
  inspectLanguages,
  inspectModel,
  inspectNavigate,
  inspectPlatformOf,
  keyView,
  NOT_CONNECTED_MESSAGE,
  OTHER_SERVER_MESSAGE,
  projectKeyIds,
  resolvedFor,
  shouldLoadProject,
  type InspectNavEvent,
  type InspectSelection,
  type InspectView,
} from "./state/inspect"
import { createPairingFlow, type PairingFlow, type PairingState } from "./state/pairing"
import { SESSION_ENDED_NOTICE, signOut, usableAuth } from "./state/session"
import { parsePrefs, parseSettingsReport } from "./state/settings"
import { useStore } from "./state/use-store"

// Dev Mode inspect panel (§7.17, P2.4): sign-in (network + clientStorage only), then the keys of the selection
// with values in every project language, snippets and Open in ReRune. Nothing here writes to the document.

type Init = MainToUiOf<"init">

const COPIED_RESET_MS = 1500

export function InspectApp(props: { bus: UiBus; init: Init }) {
  const { bus, init } = props
  const development = init.env === "development"
  const authRef = useRef<StoredAuth | null>(usableAuth(init.auth, init.apiBase))
  const [auth, setAuthState] = useState<StoredAuth | null>(authRef.current)
  const [settings, setSettings] = useState<FileSettings | null>(init.fileSettings)
  const [view, setView] = useState<InspectView>(INITIAL_INSPECT_VIEW)
  const [pairing, setPairing] = useState<{ flow: PairingFlow; state: PairingState } | null>(null)
  const [busy, setBusy] = useState(false)
  const [project, setProject] = useState<FigmaProjectDetail | null>(null)
  const [projectError, setProjectError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const [selection, setSelection] = useState<InspectSelection | null>(null)
  const [source, setSource] = useState<FigmaResolveSource>("draft")
  const [platform, setPlatform] = useState<CodegenPlatform>(() => inspectPlatformOf(parsePrefs(init.prefs)))
  const [copied, setCopied] = useState<string | null>(null)
  const signedOutRef = useRef<() => void>(() => {})
  const loadingProject = useRef<string | null>(null)

  const api = useMemo(() => createBrowserApi(init.apiBase, () => authRef.current?.token ?? null, () => signedOutRef.current()), [])
  const loader = useMemo(() => createInspectLoader({ api, saveCache: (projectId, entries) => bus.send({ type: "cache-save", projectId, entries }) }), [])
  const values = useStore(loader.store)

  function go(event: InspectNavEvent) {
    setView((current) => inspectNavigate(current, event))
  }

  function setAuth(next: StoredAuth | null) {
    authRef.current = next
    setAuthState(next)
  }

  function forgetAccount() {
    setAuth(null)
    setProject(null)
    setProjectError(null)
    loadingProject.current = null
    loader.reset()
  }

  // Any 401 from a plugin route (§7.19): forget the token and ask to sign in again.
  signedOutRef.current = () => {
    if (authRef.current === null) {
      return
    }
    bus.send({ type: "auth-clear", apiBase: init.apiBase })
    forgetAccount()
    go({ type: "signed-out", notice: SESSION_ENDED_NOTICE })
  }

  useEffect(() => {
    const off = bus.on("inspect-selection", setSelection)
    bus.send({ type: "inspect-request" })
    return off
  }, [bus])

  const access = inspectAccess(auth, settings, init.apiBase)
  const projectId = access === "ready" && settings !== null ? settings.projectId : null

  async function loadProject(id: string): Promise<void> {
    loadingProject.current = id
    setProjectError(null)
    try {
      const detail = await api.project(id)
      if (loadingProject.current === id && authRef.current !== null) {
        setProject(detail)
      }
    } catch (caught) {
      if (loadingProject.current !== id || (caught instanceof ApiError && caught.status === 401)) {
        return
      }
      if (caught instanceof ApiError && (caught.status === 403 || caught.status === 404)) {
        setProjectError("This file's ReRune project isn't available to " + (authRef.current?.user.email ?? "this account") + ".")
      } else {
        setProjectError(userMessage(caught))
      }
    } finally {
      if (loadingProject.current === id) {
        loadingProject.current = null
      }
    }
  }

  // The file's project (E9) loads after "Signed in as" is confirmed (D34).
  const loadAllowed = shouldLoadProject(access, view)
  useEffect(() => {
    if (loadAllowed && projectId !== null && project?.id !== projectId && loadingProject.current !== projectId && projectError === null) {
      setProject(null)
      void loadProject(projectId)
    }
  }, [loadAllowed, projectId, project?.id, projectError])

  const model = inspectModel(selection)
  const keyIds = project === null ? [] : projectKeyIds(model, project.id)
  const keySignature = keyIds.join(",")

  // Fresh values (E12, every project language) on each selection and source change; cache-save follows each resolve.
  useEffect(() => {
    if (project !== null) {
      void loader.load(project, keyIds, source)
    }
  }, [project, keySignature, selection, source])

  async function refresh(): Promise<void> {
    if (projectId === null) {
      return
    }
    if (values.errorReason === "unknown_language" || project === null) {
      // A language was removed from the project: reload the project's languages first.
      setProject(null)
      setProjectError(null)
      await loadProject(projectId)
      return
    }
    await loader.load(project, keyIds, source)
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

  // Sign out and "Not me" (§7.19, D34): E7, then auth-clear even if the request fails.
  async function signOutNow(event: "not-me" | "signed-out") {
    const current = authRef.current
    if (current === null) {
      return
    }
    setBusy(true)
    await signOut({ logout: (token) => api.logout(token), send: (message) => bus.send(message) }, current)
    setBusy(false)
    pairing?.flow.dispose()
    setPairing(null)
    forgetAccount()
    go(event === "not-me" ? { type: "not-me" } : { type: "signed-out", notice: null })
  }

  // A designer may connect the file while the panel is open: re-read the file settings (T7 is a read).
  async function checkAgain(): Promise<void> {
    setChecking(true)
    try {
      const report = await bus.request((requestId) => ({ type: "diagnostics-read", requestId, test: "T7-settings" }), {
        done: (message) => (message.type === "diagnostics-result" ? message.report : undefined),
      })
      const status = parseSettingsReport(report)
      if (status !== null) {
        setSettings(status.settings)
      }
    } catch {
      bus.send({ type: "notify", message: "The file's ReRune settings couldn't be read", error: true })
    } finally {
      setChecking(false)
    }
  }

  async function copy(id: string, text: string) {
    if (await copyText(text)) {
      setCopied(id)
      setTimeout(() => setCopied((current) => (current === id ? null : current)), COPIED_RESET_MS)
    } else {
      bus.send({ type: "notify", message: "Couldn't copy to the clipboard", error: true })
    }
  }

  function choosePlatform(next: CodegenPlatform) {
    setPlatform(next)
    bus.send({ type: "prefs-save", prefs: { inspectPlatform: next } })
  }

  const openDiagnostics = development ? () => go({ type: "open-diagnostics" }) : () => {}
  const email = auth?.user.email ?? null

  if (view.screen === "diagnostics" && development) {
    return (
      <DiagnosticsScreen
        bus={bus}
        editorType="dev"
        env={init.env}
        onBack={() => go({ type: "close-diagnostics" })}
        networkCheck={() => runNetworkCheck(() => api.meta(), init.apiBase)}
      />
    )
  }

  if (view.screen === "pairing" && pairing !== null) {
    return <PairingScreen state={pairing.state} onCancel={cancelSignIn} onReopen={() => pairing.flow.reopen()} onRestart={startSignIn} />
  }

  if (view.screen === "signed-in" && view.signedIn !== null && auth !== null) {
    return (
      <SignedInScreen
        auth={view.signedIn}
        busy={busy}
        onContinue={() => {
          pairing?.flow.dispose()
          setPairing(null)
          go({ type: "continue" })
        }}
        onNotMe={() => void signOutNow("not-me")}
      />
    )
  }

  if (access === "sign-in") {
    return (
      <SignInScreen
        notice={view.notice}
        version={init.pluginVersion}
        description={INSPECT_DESCRIPTION}
        onSignIn={startSignIn}
        onCreateAccount={() => bus.send({ type: "open-external", url: init.dashboardBase + "/register" })}
        onDiagnostics={development ? openDiagnostics : undefined}
      />
    )
  }

  const footer = { email, showDiagnostics: development, onSignOut: () => void signOutNow("signed-out"), onOpenDiagnostics: openDiagnostics }

  if (access === "not-connected" || access === "other-server") {
    return (
      <InspectNotice
        message={access === "not-connected" ? NOT_CONNECTED_MESSAGE : OTHER_SERVER_MESSAGE}
        action={{ label: "Check again", busy: checking, onClick: () => void checkAgain() }}
        {...footer}
      />
    )
  }

  if (project === null) {
    return projectError !== null ? (
      <InspectNotice
        message={projectError}
        tone="warning"
        action={{ label: "Try again", onClick: () => setProjectError(null) }}
        {...footer}
      />
    ) : (
      <InspectNotice message={null} loading={"Loading " + (settings?.projectName ?? "project") + "…"} {...footer} />
    )
  }

  const languages = inspectLanguages(project)
  const resolved = resolvedFor(values, source)
  const views = model.keys.map((key) =>
    keyView(key, {
      projectId: project.id,
      languages,
      source,
      platform,
      dashboardBase: init.dashboardBase,
      resolved: resolved.get(key.keyId),
      missing: values.missing.has(key.keyId),
      loading: values.status === "loading",
    }),
  )

  return (
    <InspectScreen
      projectName={project.name}
      model={model}
      views={views}
      status={values.status}
      error={values.error}
      noLanguages={languages.length === 0}
      source={source}
      platform={platform}
      copied={copied}
      email={auth?.user.email ?? ""}
      showDiagnostics={development}
      onSource={setSource}
      onPlatform={choosePlatform}
      onCopy={(id, text) => void copy(id, text)}
      onOpen={(url) => bus.send({ type: "open-external", url })}
      onRefresh={() => void refresh()}
      onSignOut={() => void signOutNow("signed-out")}
      onOpenDiagnostics={openDiagnostics}
    />
  )
}
