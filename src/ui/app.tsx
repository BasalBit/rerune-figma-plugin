import { Container, Muted, Text, useWindowResize, VerticalSpace } from "@create-figma-plugin/ui"
import { Fragment, h } from "preact"
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks"
import type { FigmaKeyRef, FigmaProject, FigmaProjectDetail } from "../shared/api-types"
import { DESIGN_UI_MAX_SIZE, DESIGN_UI_MIN_SIZE } from "../shared/constants"
import { confirmSameFile, linkSyncGate, pushFileKey, withFileLink, type LinkSyncBlock } from "../shared/file-link"
import type { ParsedFigmaUrl } from "../shared/figma-url"
import type { FileSettings, MainToUiOf, ScannedNode, Scope, StoredAuth } from "../shared/messages"
import { ApiError, userMessage } from "./api/client"
import { createBrowserApi } from "./api/browser"
import { browserEnvironment, createUiBus, type UiBus } from "./bus"
import { InspectApp } from "./inspect-app"
import { measureImage } from "./image"
import { FileLinkNote } from "./components/file-link"
import { Nav } from "./components/nav"
import { RefreshRequestsNote, refreshNotesShown } from "./components/refresh-requests"
import { ErrorGroups, GlobalStyle, Loading, Note, styles, TextButton } from "./components/ui"
import { runNetworkCheck } from "./diagnostics"
import { DiagnosticsScreen } from "./screens/diagnostics"
import { LayersScreen } from "./screens/layers"
import { LinkDialog } from "./screens/link-dialog"
import { PairingScreen } from "./screens/pairing"
import { ProjectScreen } from "./screens/project-picker"
import { PreviewScreen } from "./screens/preview"
import { PushScreen, type PushTask } from "./screens/push"
import { NEW_QA_SESSION, QaScreen, type QaSession } from "./screens/qa"
import { SettingsOfferNote, SettingsScreen } from "./screens/settings"
import { SignInScreen } from "./screens/sign-in"
import { SignedInScreen } from "./screens/signed-in"
import {
  awaitingSignInConfirmation,
  connectedSettings,
  initialView,
  isWorkspaceScreen,
  navigate,
  type AppView,
  type NavContext,
  type NavEvent,
  type Screen,
} from "./state/navigation"
import { fileLinkNotice, registerFile, saveAndRegisterFile, type FileLinkAction } from "./state/file-link"
import { AUTO_SYNC_RUNNING, autoPageSyncNote, createLinkSyncer, createPageSync, linkSyncWarning } from "./state/link-sync"
import { createFailedFrames } from "./state/missing-screenshots"
import { createScanRunner, groupErrors, layerCount, LONG_OP_IDLE_MS, runOp, singleFlight, type ErrorGroup } from "./state/ops"
import { createPairingFlow, type PairingFlow, type PairingState } from "./state/pairing"
import { leftoverPreviewNotice, previewStatus, resetOutcome } from "./state/preview"
import { createRefreshRequests, refetchAfterUpload, refreshGate } from "./state/refresh-requests"
import { cacheEntriesFromResolved } from "./state/remote"
import { projectGoneMessage, projectRead } from "./state/project-watch"
import { availabilityRead, browserWindow, createWatchSchedule } from "./state/request-watch"
import type { ProjectPluralChoice } from "./state/samples"
import {
  createAvailability,
  emptyScreenshotRun,
  screenshotDeps,
  screenshotGate,
  screenshotSetting,
  uploadScreenshots,
  type Availability,
  type ScreenshotUploader,
} from "./state/screenshots"
import { SESSION_ENDED_NOTICE, signOut, usableAuth } from "./state/session"
import { API_BASE_MISMATCH_HINT, connectProject, parsePrefs, parseSettingsReport, replaceServerQuestion, settingsOffer, type Prefs, type SettingsStatus } from "./state/settings"
import { useStore } from "./state/use-store"
import { createWorkLock, type WorkLock, type WorkTask } from "./state/work-lock"
import { createWorkspace } from "./state/workspace"

type Init = MainToUiOf<"init">

interface Banner { tone: "good" | "info" | "warning"; message: string; errors: ErrorGroup[] }

// Design mode (§7.8): sign-in, project, and the Layers / Push / Preview / QA / Settings workspace.
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
  // One canvas task at a time: a push (with its screenshots), a preview apply, pseudo-localization, an overflow
  // report, language copies or Update screenshots holds the work lock, which keeps the tabs and Change project put and
  // refuses the others.
  const [workTask, setWorkTask] = useState<WorkTask | null>(null)
  const workLocked = workTask !== null
  const contextRef = useRef<NavContext>({ apiBase: init.apiBase, settings })
  contextRef.current = { apiBase: init.apiBase, settings, locked: workLocked }
  // Re-reads the page status (settings and its count of previews) when a task ends; set once refreshStatus exists.
  const refreshStatusRef = useRef<() => Promise<unknown>>(() => Promise.resolve(null))
  const workLock = useMemo<WorkLock>(
    () =>
      createWorkLock((holder) => {
        setWorkTask(holder)
        contextRef.current = { ...contextRef.current, locked: holder !== null }
        if (holder === null) {
          void refreshStatusRef.current()
        }
      }),
    [],
  )
  const [view, setView] = useState<AppView>(() => initialView(authRef.current, contextRef.current))
  const [diagnosticsReturn, setDiagnosticsReturn] = useState<Screen>("sign-in")
  const [link, setLink] = useState<{ nodes: ScannedNode[]; key: FigmaKeyRef | null } | null>(null)
  const [pairing, setPairing] = useState<{ flow: PairingFlow; state: PairingState } | null>(null)
  const [notMeBusy, setNotMeBusy] = useState(false)
  const [editedPrompt, setEditedPrompt] = useState<{ scope: Scope; nodeIds: string[] } | null>(null)
  const [resetting, setResetting] = useState(false)
  const [offerDismissedOn, setOfferDismissedOn] = useState<string | null>(null)
  const [leftoverDismissedOn, setLeftoverDismissedOn] = useState<string | null>(null)
  const [offerSaving, setOfferSaving] = useState(false)
  // The plural form picked on the Preview screen (§7.18.5), for this session and the project it was picked in.
  const [pluralChoice, setPluralChoice] = useState<ProjectPluralChoice | null>(null)
  // The QA tab's picks and last results, kept while other tabs are open.
  const [qaSession, setQaSession] = useState<QaSession>(NEW_QA_SESSION)
  const [banner, setBanner] = useState<Banner | null>(null)
  const signedOutRef = useRef<() => void>(() => {})
  // figma.root.name for the copy heuristic (§7.7): from init, refreshed with the T7 settings status.
  const [rootName, setRootName] = useState(init.fileName)
  const rootNameRef = useRef(init.fileName)
  const [dismissedNotices, setDismissedNotices] = useState<LinkSyncBlock[]>([])
  const [noticeBusy, setNoticeBusy] = useState(false)
  // The notices at the top of the open tab's scroll area (see `notices` below).
  const noticesRef = useRef<HTMLDivElement>(null)
  // A Layers action (link, unlink, keep copied, remove, page sync) runs: the automatic page sync waits for it.
  const [layersBusy, setLayersBusy] = useState(false)

  const api = useMemo(() => createBrowserApi(init.apiBase, () => authRef.current?.token ?? null, () => signedOutRef.current()), [])
  // E1 screenshots_enabled and E8 sandbox_expires_at for screenshots on push (§7.16, D4), once per session.
  const availabilityLoader = useMemo(() => createAvailability(api), [])
  const [availability, setAvailability] = useState<Availability>(() => availabilityLoader.current())
  const prefsRef = useRef(prefs)
  prefsRef.current = prefs
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

  // The Push screen reports its runs as busy / not busy: a push or pull, or Upload screenshots.
  function pushBusy(busy: boolean, task: PushTask) {
    if (busy) {
      workLock.acquire(task)
    } else {
      workLock.release(task)
    }
  }

  function setAuth(next: StoredAuth | null) {
    authRef.current = next
    setAuthState(next)
  }

  function setActiveProject(next: FigmaProjectDetail | null) {
    projectRef.current = next
    setProject(next)
  }

  function forgetAccount() {
    availabilityLoader.reset()
    setAvailability(availabilityLoader.current())
  }

  signedOutRef.current = () => {
    if (authRef.current === null) {
      return
    }
    bus.send({ type: "auth-clear", apiBase: init.apiBase })
    forgetAccount()
    setAuth(null)
    setActiveProject(null)
    setLink(null)
    pageSync.reset()
    refreshRequests.reset()
    workspace.clear(true)
    go({ type: "signed-out", notice: SESSION_ENDED_NOTICE })
  }

  // Re-reads the settings status (T7) and returns it, or null when it could not be read.
  async function refreshStatus(): Promise<SettingsStatus | null> {
    try {
      const report = await bus.request((requestId) => ({ type: "diagnostics-read", requestId, test: "T7-settings" }), {
        done: (message) => (message.type === "diagnostics-result" ? message.report : undefined),
      })
      const next = parseSettingsReport(report)
      if (next !== null) {
        setStatus(next)
        setSettings(next.settings)
        if (next.rootName !== null) {
          rootNameRef.current = next.rootName
          setRootName(next.rootName)
        }
      }
      return next
    } catch {
      // The status only adds the Repair/mirror offers and the file's current name; init's values stay in use.
      return null
    }
  }

  refreshStatusRef.current = refreshStatus

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
        setProjectError(projectGoneMessage(authRef.current?.user.email ?? null))
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

  // The file's project was deleted, or this account lost access to it, while the plugin was open: as when it opens.
  function projectGone() {
    setActiveProject(null)
    setLink(null)
    pageSync.reset()
    refreshRequests.reset()
    workspace.clear(true)
    setProjectError(projectGoneMessage(authRef.current?.user.email ?? null))
    go({ type: "change-project" })
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
  const usableRef = useRef(usable)
  usableRef.current = usable
  // Link sync (Phase 2, §7.11): on only for a confirmed main file and a user with edit_keys (D43).
  const gate = linkSyncGate(usable, rootName, project?.permissions ?? [])
  const gateRef = useRef(gate)
  gateRef.current = gate
  const linkSyncer = useMemo(() => createLinkSyncer({ api, bus, projectId: () => projectRef.current?.id ?? null, gate: () => gateRef.current }), [])
  // "Sync links on this page" and its automatic run after a saved or confirmed file link (§7.7, §7.15): one at a
  // time in the app, whichever tab is open.
  const pageSync = useMemo(
    () =>
      createPageSync({
        scanPage: () => workspace.scan("page"),
        scanError: () => workspace.store.get().error,
        scanPageDetached: () => workspace.scanDetached("page"),
        syncPage: (pageId, scanned, options) => linkSyncer.syncPage(pageId, scanned, options),
      }),
    [],
  )
  const pageSyncState = useStore(pageSync.store)
  // The file's project (E9) loads only after "Signed in as" is confirmed: a 403/404 for the new account then
  // leads to the Project screen instead of skipping the confirmation (D34).
  const confirming = awaitingSignInConfirmation(view)
  useEffect(() => {
    if (auth !== null && usable !== null && !confirming) {
      ensureProject(usable.projectId)
    }
  }, [auth, usable?.projectId, confirming])

  // Whether screenshots can be uploaded (E1, E8) is asked once the workspace opens, so Settings knows whether to
  // show the toggle (hidden for sandbox users, D4) and the first push needs no extra wait.
  useEffect(() => {
    if (auth !== null && project !== null) {
      void availabilityLoader.load().then(setAvailability)
    }
  }, [auth, project?.id])

  // Screenshots of changed frames (§7.13 rule 11, §7.16, SF1): the gate is evaluated when a push or pull ends, with
  // the settings, prefs and permissions of that moment. Update screenshots (SF6) ignores the setting.
  const screenshotUploader = useMemo<ScreenshotUploader>(
    () => ({
      async prepare(options) {
        const loaded = await availabilityLoader.load()
        setAvailability(loaded)
        const gate = screenshotGate({
          pref: options?.ignorePref === true || prefsRef.current.uploadScreenshotsOnPush,
          availability: loaded,
          settings: usableRef.current,
          rootName: rootNameRef.current,
          permissions: projectRef.current?.permissions ?? [],
        })
        return { gate, availability: loaded }
      },
      upload(frames, options) {
        const active = projectRef.current
        if (active === null) {
          return Promise.resolve({ ...emptyScreenshotRun(frames.length), stopped: "signed_out" as const, notUploaded: frames.length })
        }
        const deps = screenshotDeps({
          api,
          bus,
          projectId: active.id,
          measure: measureImage,
          onDisabled: () => {
            availabilityLoader.disable()
            setAvailability(availabilityLoader.current())
          },
        })
        return uploadScreenshots(deps, frames, options)
      },
    }),
    [],
  )

  // The frames ReRune asks new screenshots of (screenshot freshness, SF6): read when the workspace opens on a confirmed
  // file, after the file link is saved and after every upload run; Update screenshots runs from the notices.
  const freshnessGate = refreshGate({ availability, settings: usable, rootName, permissions: project?.permissions ?? [] })
  const freshnessGateRef = useRef(freshnessGate)
  freshnessGateRef.current = freshnessGate
  const refreshRequests = useMemo(
    () =>
      createRefreshRequests({
        api,
        bus,
        context: () => {
          const active = projectRef.current
          return active === null
            ? null
            : { projectId: active.id, mainLanguage: active.main_language, gate: freshnessGateRef.current, groupIdenticalTexts: prefsRef.current.groupIdenticalTexts }
        },
        scanFrames: (frameIds) => workspace.scanFrames(frameIds),
        uploader: screenshotUploader,
        lock: workLock,
        // Its pulls show at once on Layers and Push, and their keys are read again.
        pulled: (change) => {
          const keyIds = workspace.applyChanges(change)
          if (keyIds.length > 0) {
            void workspace.refreshKeys({ keyIds })
          }
        },
      }),
    [],
  )
  const refreshState = useStore(refreshRequests.store)
  // Push, pull, Overwrite and Take ReRune text: their uploads clear requests, so the requests are read again after each.
  const pushUploader = useMemo(() => refetchAfterUpload(screenshotUploader, () => refreshRequests.fetch()), [])
  // Frames whose upload failed for a lasting reason (too large, the project's screenshot limit, …): pushes leave them
  // out for the rest of the session, so they aren't exported and sent again for the same answer (missing-screenshots.ts).
  const failedShots = useMemo(() => createFailedFrames(), [])
  useEffect(() => {
    if (auth !== null && project !== null) {
      void refreshRequests.fetch()
    }
  }, [auth, project?.id, freshnessGate.enabled, freshnessGate.fileKey, usable?.updatedAt])
  // While the plugin stays open, the project's details, the values of the keys in view and the screenshot requests are
  // read again when its window is shown or gets the user's attention and every minute while it is visible and in use,
  // one after the other on one schedule (request-watch.ts), so changes made in the dashboard show without reopening
  // the plugin. Not while a task holds the work lock: a push, a pull or Update screenshots reads what it needs itself.
  const schedule = useMemo(() => createWatchSchedule({ busy: () => workLock.holder() !== null, window: browserWindow(document, window) }), [])
  // Languages, variations, permissions and the rest of E9: applied everywhere at once. A main language change loads
  // the remote state again; a project that is gone or no longer open to this account leads to the Project screen.
  const projectWatch = useMemo(
    () =>
      schedule.add(
        projectRead({
          api,
          current: () => (authRef.current === null ? null : projectRef.current),
          loading: () => loadingProject.current !== null,
          held: () => workLock.holder() !== null,
          apply: (detail, change) => {
            setActiveProject(detail)
            if (change.mainLanguage) {
              void workspace.refreshRemote()
            }
          },
          gone: () => projectGone(),
        }),
      ),
    [],
  )
  // The keys of the last scan, without scanning the canvas again (at most 500 per round, in calls of E1's
  // max_batch_size): a change made in ReRune shows on Layers and Push. Not while a scan, the workspace's own load, a
  // Layers action, a page sync, a reset or the Link dialog runs.
  const keysBusyRef = useRef(false)
  keysBusyRef.current = layersBusy || link !== null || resetting || pageSyncState.running !== null
  const availabilityRef = useRef(availability)
  availabilityRef.current = availability
  const keysWatch = useMemo(
    () =>
      schedule.add({
        busy: () => keysBusyRef.current || workspace.store.get().status === "scanning",
        fetch: () => workspace.refreshKeys({ chunkSize: availabilityRef.current.meta?.max_batch_size }),
      }),
    [],
  )
  const workspaceOpen = auth !== null && project !== null
  useEffect(() => {
    if (!workspaceOpen) {
      return
    }
    projectWatch.start()
    keysWatch.start()
    return () => {
      projectWatch.stop()
      keysWatch.stop()
    }
  }, [workspaceOpen, project?.id])
  // The requests: not while a run or another read of them is going on (a push's uploads read them when they end).
  const requestWatch = useMemo(() => schedule.add({ fetch: () => refreshRequests.fetch(), busy: () => refreshRequests.busy() }), [])
  const watching = auth !== null && project !== null && freshnessGate.enabled
  useEffect(() => {
    if (!watching) {
      return
    }
    requestWatch.start()
    return () => requestWatch.stop()
  }, [watching, project?.id, freshnessGate.fileKey])
  // When E1 or E8 failed as the workspace opened (a brief network or server error), the refresh gate stays closed:
  // they are read again on the same schedule, so the requests show without reopening the plugin.
  const availabilityWatch = useMemo(() => schedule.add({ fetch: availabilityRead(() => availabilityLoader.load(), setAvailability) }), [])
  const availabilityFailed = auth !== null && project !== null && availability.error !== null
  useEffect(() => {
    if (!availabilityFailed) {
      return
    }
    availabilityWatch.start()
    return () => availabilityWatch.stop()
  }, [availabilityFailed, project?.id])
  // A selection or page change means someone uses Figma: the schedule keeps reading every minute.
  useEffect(() => bus.on("selection-changed", () => schedule.activity()), [])

  // QA picks and results belong to the project they were made in.
  useEffect(() => {
    setQaSession(NEW_QA_SESSION)
  }, [project?.id])

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

  // The notices scroll with the tab, so a new result banner or edited-during-preview question is brought into view
  // when the tab was scrolled down (e.g. Reset in the header while reading the Preview results).
  useEffect(() => {
    if (banner !== null || editedPrompt !== null || pageSyncState.auto !== null || refreshState.outcome !== null) {
      noticesRef.current?.scrollIntoView({ block: "nearest" })
    }
  }, [banner, editedPrompt, pageSyncState.auto, refreshState.outcome])

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

  // Picking a project saves the pasted file link with it (§7.7) and registers the file in that project (E14).
  async function pickProject(picked: FigmaProject, link: ParsedFigmaUrl | null): Promise<void> {
    if (link !== null) {
      await refreshStatus()
    }
    let next = connectProject(settings, picked, init.apiBase, Date.now())
    if (link !== null) {
      next = withFileLink(next, link, rootNameRef.current, Date.now())
    }
    const changed = settings?.projectId !== picked.id || settings?.apiBase !== init.apiBase
    await saveSettings(next)
    pageSync.reset()
    refreshRequests.reset()
    contextRef.current = { apiBase: init.apiBase, settings: next, locked: workLocked }
    if (changed) {
      workspace.clear(true)
    }
    setProjectError(null)
    ensureProject(picked.id)
    go({ type: "project-connected" })
    void registerFile(api, picked.id, next, rootNameRef.current, picked.permissions).then((result) => {
      if (result.error !== null) {
        setBanner({ tone: "warning", message: result.error, errors: [] })
      }
    })
  }

  function knownNodes(): ScannedNode[] {
    return workspace.store.get().result?.nodes ?? []
  }

  // Link sync after the Link dialog wrote or removed links (§7.11); a failure becomes a banner.
  async function syncAfterWrite(nodeIds: string[]): Promise<void> {
    if (nodeIds.length === 0) {
      return
    }
    const warning = linkSyncWarning(await linkSyncer.syncNodes(nodeIds, knownNodes()))
    if (warning !== null) {
      setBanner({ tone: "warning", message: warning, errors: [] })
    }
  }

  // Saves the settings with the file's link and registers the file (E14); when E14 worked and link sync is on, the
  // links made while sync was off reach ReRune through the automatic page sync, on the open tab (no navigation).
  // Returns a warning when E14 failed.
  function saveAndRegister(next: FileSettings, active: FigmaProjectDetail): Promise<string | null> {
    return saveAndRegisterFile(
      { api, apiBase: init.apiBase, save: saveSettings, requestPageSync: () => pageSync.request() },
      { projectId: active.id, permissions: active.permissions, settings: next, rootName: rootNameRef.current },
    )
  }

  // A pasted file link (§7.7): saved to the file, then registered (E14). Returns a warning when E14 failed.
  async function saveFileLink(link: ParsedFigmaUrl): Promise<string | null> {
    const fresh = await refreshStatus()
    const current = connectedSettings({ apiBase: init.apiBase, settings: fresh?.settings ?? contextRef.current.settings })
    const active = projectRef.current
    if (current === null || active === null) {
      throw new Error("Connect this file to a ReRune project first.")
    }
    return saveAndRegister(withFileLink(current, link, rootNameRef.current, Date.now()), active)
  }

  // "This is the same file" (§7.7): the stored name follows the file's current name, which resumes sync.
  async function confirmFile(): Promise<string | null> {
    const fresh = await refreshStatus()
    const current = connectedSettings({ apiBase: init.apiBase, settings: fresh?.settings ?? contextRef.current.settings })
    const active = projectRef.current
    if (current === null || active === null) {
      return null
    }
    return saveAndRegister(confirmSameFile(current, rootNameRef.current, Date.now()), active)
  }

  async function fileNoticeAction(action: FileLinkAction): Promise<void> {
    if (action === "paste-link") {
      go({ type: "open", screen: "settings" })
      return
    }
    setNoticeBusy(true)
    try {
      const warning = await confirmFile()
      if (warning !== null) {
        setBanner({ tone: "warning", message: warning, errors: [] })
      }
    } catch (caught) {
      setBanner({ tone: "warning", message: caught instanceof Error ? caught.message : "The settings couldn't be saved.", errors: [] })
    } finally {
      setNoticeBusy(false)
    }
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
    forgetAccount()
    setAuth(null)
    setActiveProject(null)
    setLink(null)
    pageSync.reset()
    refreshRequests.reset()
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
    // The page's count of previews (the note about previews the scan does not show) follows the reset.
    await refreshStatus()
  }

  const resetWork = useRef(runResetPreviews)
  resetWork.current = runResetPreviews
  const resetFlight = useMemo(() => singleFlight((scope: Scope, nodeIds?: string[], edited?: "keep" | "restore") => resetWork.current(scope, nodeIds, edited), setResetting), [])

  function resetPreviews(scope: Scope, nodeIds?: string[], edited?: "keep" | "restore"): Promise<void> {
    return resetFlight.run(scope, nodeIds, edited)
  }

  // The overflow report's final reset (§7.18.1, always): after a reset that is already running, never merged into it,
  // so exactly the layers the report wrote are reset.
  function resetPreviewsQueued(scope: Scope, nodeIds: string[]): Promise<void> {
    return resetFlight.queue(scope, nodeIds)
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

  // The automatic page sync (§7.7) starts once no canvas task, reset, scan, Link dialog or Layers action runs and a
  // workspace tab is open; it is dropped when link sync is off by then (the project's permissions are loaded).
  const autoSyncBusy = workLocked || resetting || layersBusy || link !== null || space.status === "scanning" || !isWorkspaceScreen(screen)
  const projectLoaded = project !== null
  useEffect(() => {
    if (projectLoaded) {
      pageSync.offer(pageRef.current, { syncEnabled: gate.enabled, readOnly, busy: autoSyncBusy })
    }
  }, [pageSyncState.requested, pageSyncState.running, gate.enabled, readOnly, autoSyncBusy, projectLoaded])

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
        banner={projectError ?? (readOnly ? API_BASE_MISMATCH_HINT : null)}
        canGoBack={usable !== null && project !== null}
        confirmPick={(picked) => replaceServerQuestion(settings, init.apiBase, picked.name)}
        onPick={pickProject}
        onBack={() => go({ type: "open", screen: "layers" })}
        onSignOut={() => void signOutNow("signed-out")}
        onUser={(user) => {
          availabilityLoader.setUser(user)
          setAvailability(availabilityLoader.current())
        }}
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
        onLinksWritten={syncAfterWrite}
      />
    )
  }

  const previewing = previewStatus(space.result?.nodes ?? [])
  // Keep current text / Restore original (and the header's Reset) wait while a reset or locked work (push, preview
  // apply, pseudo-localization, overflow report, language copies) runs: a reset started then would overlap that work.
  const editedPromptBusy = resetting || workLocked
  // Previews on this page the scan does not show (e.g. the plugin was closed during an overflow report, §7.18.1).
  const leftover = leftoverDismissedOn === pageRef.current ? null : leftoverPreviewNotice({ pagePreviews: status?.pagePreviews ?? 0, scanStatus: previewing, busy: editedPromptBusy })
  // §7.7 Repair / page-mirror offer when the plugin opens on a page that needs it (Settings shows its own copy).
  const offer = screen !== "settings" && offerDismissedOn !== pageRef.current ? settingsOffer(status) : null
  // Why link sync is off (§7.7, §7.11); Settings shows the same state in its Figma file section.
  const notice = screen !== "settings" ? fileLinkNotice(gate) : null
  const fileNotice = notice !== null && !(notice.dismissible && dismissedNotices.includes(notice.reason)) ? notice : null
  // The automatic page sync's progress and result for the open page.
  const autoSyncNote = pageSyncState.auto !== null && pageSyncState.auto.pageId === pageRef.current ? pageSyncState.auto : null
  const autoSyncRunning = pageSyncState.running === "auto"
  // Update screenshots waits like the automatic page sync: for a canvas task, a reset, a scan, a page sync or a Layers
  // action (its detached scan would cancel a shown scan's, or be cancelled by one).
  const refreshBusy = workLocked || resetting || layersBusy || pageSyncState.running !== null || space.status === "scanning"
  const refreshShown = refreshNotesShown(refreshState)

  async function applyOffer(): Promise<void> {
    if (offer === null) return
    setOfferSaving(true)
    try {
      await saveSettings(offer.settings)
    } catch (caught) {
      setBanner({ tone: "warning", message: caught instanceof Error ? caught.message : "The settings couldn't be saved.", errors: [] })
    } finally {
      setOfferSaving(false)
    }
  }

  // The notices about this file and the last action. Each tab shows them first in its scroll area (ScreenBody), in
  // normal flow, so they take their own space above the tab's content and scroll with it.
  const notices =
    offer !== null || fileNotice !== null || autoSyncRunning || autoSyncNote !== null || refreshShown || editedPrompt !== null || leftover !== null || banner !== null ? (
      <div ref={noticesRef} style={{ ...styles.stack, scrollMarginTop: styles.body.padding }}>
        {offer !== null && <SettingsOfferNote offer={offer} disabled={readOnly || offerSaving} onApply={() => void applyOffer()} onDismiss={() => setOfferDismissedOn(pageRef.current)} />}
        {fileNotice !== null && (
          <FileLinkNote
            notice={fileNotice}
            busy={noticeBusy}
            disabled={readOnly}
            onAction={(action) => void fileNoticeAction(action)}
            onDismiss={() => setDismissedNotices((current) => [...current, fileNotice.reason])}
          />
        )}
        {autoSyncRunning && <Note tone="info">{AUTO_SYNC_RUNNING}</Note>}
        {autoSyncNote !== null && (
          <Note
            tone={autoSyncNote.error !== null || (autoSyncNote.result !== null && autoSyncNote.result.error !== null) ? "warning" : "good"}
            actions={<TextButton onClick={() => pageSync.dismiss()}>Dismiss</TextButton>}
          >
            {autoPageSyncNote(autoSyncNote)}
          </Note>
        )}
        {refreshShown && (
          <RefreshRequestsNote
            state={refreshState}
            busy={refreshBusy}
            resetting={resetting}
            onRun={() => void refreshRequests.run()}
            onNotNow={() => refreshRequests.notNow()}
            onStop={() => refreshRequests.stop()}
            onResetPreviews={(nodeIds) =>
              void resetPreviews(space.scope, nodeIds)
                .then(() => refreshRequests.dismissOutcome())
                .catch((caught: unknown) => setBanner({ tone: "warning", message: userMessage(caught), errors: [] }))
            }
            onRemove={(screenshotId) => void refreshRequests.removeRequest(screenshotId)}
            onRemoveAll={() => void refreshRequests.removeAll()}
            onDismiss={() => refreshRequests.dismissOutcome()}
            onSelect={selectNodes}
          />
        )}
        {editedPrompt !== null && (
          <Note
            tone="warning"
            actions={
              <div style={styles.row}>
                <TextButton disabled={editedPromptBusy} onClick={() => void resetPreviews(editedPrompt.scope, editedPrompt.nodeIds, "keep")}>
                  Keep current text
                </TextButton>
                <TextButton disabled={editedPromptBusy} onClick={() => void resetPreviews(editedPrompt.scope, editedPrompt.nodeIds, "restore")}>
                  Restore original
                </TextButton>
              </div>
            }
          >
            {layerCount(editedPrompt.nodeIds.length)} {editedPrompt.nodeIds.length === 1 ? "was" : "were"} edited during preview.
          </Note>
        )}
        {leftover !== null && (
          <Note
            tone="warning"
            actions={
              <div style={styles.row}>
                <TextButton onClick={() => void resetPreviews("page").catch((caught: unknown) => setBanner({ tone: "warning", message: userMessage(caught), errors: [] }))}>
                  Reset page
                </TextButton>
                <TextButton onClick={() => setLeftoverDismissedOn(pageRef.current)}>Dismiss</TextButton>
              </div>
            }
          >
            {leftover}
          </Note>
        )}
        {banner !== null && (
          <div style={styles.tightStack}>
            <Note tone={banner.tone} actions={<TextButton onClick={() => setBanner(null)}>Dismiss</TextButton>}>
              {banner.message}
            </Note>
            <ErrorGroups groups={banner.errors} onSelect={selectNodes} />
          </div>
        )}
      </div>
    ) : null

  return (
    <div style={styles.page}>
      <Nav
        active={screen}
        projectName={project.name}
        selectionCount={selectionCount}
        previewStatus={previewing}
        onOpen={(next) => go({ type: "open", screen: next })}
        onChangeProject={() => go({ type: "change-project" })}
        lockedBy={workTask}
        resetDisabled={editedPromptBusy}
        onResetPreview={() => void resetPreviews("page").catch((caught: unknown) => setBanner({ tone: "warning", message: userMessage(caught), errors: [] }))}
      />
      <div style={{ flex: "1", minHeight: "0", display: "flex", flexDirection: "column" }}>
        {screen === "layers" && (
          <LayersScreen
            notices={notices}
            workspace={workspace}
            state={space}
            projectId={project.id}
            readOnly={readOnly}
            api={api}
            bus={bus}
            onOpenLink={(nodes) => setLink({ nodes, key: null })}
            onSelect={selectNodes}
            linkSync={linkSyncer}
            syncEnabled={gate.enabled}
            pageId={pageRef.current}
            pageSync={pageSync}
            onBusy={setLayersBusy}
            locked={workLocked}
          />
        )}
        {screen === "push" && (
          <PushScreen
            notices={notices}
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
            onAvailableKeys={(availableKeys) => {
              // The project as it is now: details read while the push ran are kept.
              const current = projectRef.current
              if (current !== null) setActiveProject({ ...current, available_keys: availableKeys })
            }}
            onBusy={pushBusy}
            locked={workTask !== null && workTask !== "push" && workTask !== "upload"}
            fileKey={pushFileKey(usable, rootName)}
            syncLinks={(nodeIds) => linkSyncer.syncNodes(nodeIds, knownNodes())}
            screenshots={pushUploader}
            failedShots={failedShots}
          />
        )}
        {screen === "preview" && (
          <PreviewScreen
            notices={notices}
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
            locked={workLocked}
            work={workLock}
            onReset={(scope, nodeIds) => resetPreviews(scope, nodeIds)}
            pluralChoice={pluralChoice}
            onPluralChoice={setPluralChoice}
          />
        )}
        {screen === "qa" && (
          <QaScreen
            notices={notices}
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
            locked={workLocked}
            work={workLock}
            onReset={(scope, nodeIds) => resetPreviews(scope, nodeIds)}
            onReportReset={resetPreviewsQueued}
            pluralChoice={pluralChoice}
            onPluralChoice={setPluralChoice}
            session={qaSession}
            onSession={(patch) => setQaSession((current) => ({ ...current, ...patch }))}
          />
        )}
        {screen === "settings" && (
          <SettingsScreen
            notices={notices}
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
            linkGate={gate}
            onSaveFileLink={saveFileLink}
            onConfirmSameFile={confirmFile}
            locked={workLocked}
            screenshots={screenshotSetting(
              screenshotGate({ pref: prefs.uploadScreenshotsOnPush, availability, settings: usable, rootName, permissions: project.permissions }),
              availability,
            )}
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
