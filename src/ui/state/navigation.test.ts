import { describe, expect, it } from "vitest"
import { PROJECT_ID } from "../../../test/fixtures"
import type { StoredAuth } from "../../shared/messages"
import { newFileSettings } from "../../shared/plugin-data"
import { awaitingSignInConfirmation, connectedSettings, homeScreen, initialView, isWorkspaceScreen, navigate, type NavContext } from "./navigation"
import { fullName, SESSION_ENDED_NOTICE, usableAuth } from "./session"

const API = "http://localhost:8080"
const AUTH: StoredAuth = { apiBase: API, token: "rrf_x", tokenId: "t", tokenExpiresAt: "", user: { id: "u", email: "ada@example.com", firstName: "Ada", lastName: "" }, savedAt: 1 }
const SETTINGS = newFileSettings({ apiBase: API, projectId: PROJECT_ID, projectName: "Chapter", now: 1 })

describe("navigation", () => {
  const connected: NavContext = { apiBase: API, settings: SETTINGS }
  const fresh: NavContext = { apiBase: API, settings: null }
  const foreign: NavContext = { apiBase: API, settings: { ...SETTINGS, apiBase: "https://rerune.io/api" } }

  it("starts at Sign in, Project or Layers", () => {
    expect(initialView(null, connected).screen).toBe("sign-in")
    expect(initialView(AUTH, fresh).screen).toBe("project")
    expect(initialView(AUTH, connected).screen).toBe("layers")
    expect(initialView(AUTH, foreign).screen).toBe("project")
    expect(connectedSettings(foreign)).toBeNull()
    expect(homeScreen(true, connected)).toBe("layers")
  })

  it("shows Signed in as once, then Continue goes home", () => {
    let view = navigate(initialView(null, connected), { type: "start-sign-in" }, connected)
    view = navigate(view, { type: "pairing-approved", auth: AUTH }, connected)
    expect(view).toEqual({ screen: "signed-in", notice: null, signedIn: AUTH })
    view = navigate(view, { type: "continue" }, connected)
    expect(view).toEqual({ screen: "layers", notice: null, signedIn: null })
  })

  it("keeps Signed in as when the file's project can't be opened by the new account (D34)", () => {
    let view = navigate(initialView(null, connected), { type: "start-sign-in" }, connected)
    view = navigate(view, { type: "pairing-approved", auth: AUTH }, connected)
    expect(awaitingSignInConfirmation(view)).toBe(true)
    view = navigate(view, { type: "change-project" }, connected)
    expect(view).toEqual({ screen: "signed-in", notice: null, signedIn: AUTH })
    view = navigate(view, { type: "continue" }, connected)
    expect(awaitingSignInConfirmation(view)).toBe(false)
    // The project loads now; a 403/404 then opens the Project screen.
    expect(navigate(view, { type: "change-project" }, connected).screen).toBe("project")
  })

  it("returns to Sign in with a notice when the session ends", () => {
    const view = navigate({ screen: "push", notice: null, signedIn: null }, { type: "signed-out", notice: SESSION_ENDED_NOTICE }, connected)
    expect(view).toEqual({ screen: "sign-in", notice: SESSION_ENDED_NOTICE, signedIn: null })
    expect(navigate(view, { type: "start-sign-in" }, connected).notice).toBeNull()
    expect(navigate(view, { type: "pairing-cancelled" }, connected).screen).toBe("sign-in")
  })

  it("stays on Push while a push runs, but still signs out", () => {
    const locked: NavContext = { ...connected, locked: true }
    const push = { screen: "push" as const, notice: null, signedIn: null }
    expect(navigate(push, { type: "open", screen: "layers" }, locked)).toBe(push)
    expect(navigate(push, { type: "open", screen: "diagnostics" }, locked)).toBe(push)
    expect(navigate(push, { type: "change-project" }, locked)).toBe(push)
    expect(navigate(push, { type: "signed-out", notice: SESSION_ENDED_NOTICE }, locked).screen).toBe("sign-in")
    expect(navigate(push, { type: "open", screen: "layers" }, connected).screen).toBe("layers")
  })

  it("opens workspace screens only for a connected file", () => {
    const base = { screen: "layers" as const, notice: null, signedIn: null }
    expect(navigate(base, { type: "open", screen: "push" }, connected).screen).toBe("push")
    expect(navigate(base, { type: "open", screen: "push" }, fresh).screen).toBe("project")
    expect(navigate(base, { type: "open", screen: "settings" }, fresh).screen).toBe("settings")
    expect(navigate(base, { type: "open", screen: "diagnostics" }, fresh).screen).toBe("diagnostics")
    expect(navigate(base, { type: "change-project" }, connected).screen).toBe("project")
    expect(navigate({ ...base, screen: "project" }, { type: "project-connected" }, connected).screen).toBe("layers")
    expect(navigate(base, { type: "open", screen: "qa" }, connected).screen).toBe("qa")
    expect(navigate(base, { type: "open", screen: "qa" }, fresh).screen).toBe("project")
    expect(isWorkspaceScreen("preview")).toBe(true)
    expect(isWorkspaceScreen("qa")).toBe(true)
    expect(isWorkspaceScreen("pairing")).toBe(false)
  })
})

describe("session helpers", () => {
  it("joins names and ignores auth for another server", () => {
    expect(fullName({ firstName: " Ada ", lastName: "Lovelace" })).toBe("Ada Lovelace")
    expect(fullName({ firstName: "", lastName: "" })).toBe("")
    expect(usableAuth(AUTH, API)).toBe(AUTH)
    expect(usableAuth(AUTH, "https://rerune.io/api")).toBeNull()
    expect(usableAuth(null, API)).toBeNull()
  })
})
