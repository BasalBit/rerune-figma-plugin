import type { FileSettings, StoredAuth } from "../../shared/messages"

// Design-mode screens (§7.8) and the transitions between them. Pure, so the sign-in → "Signed in as" →
// Project path (D34) is unit-tested without a DOM.

export type Screen = "sign-in" | "pairing" | "signed-in" | "project" | "layers" | "push" | "preview" | "settings" | "diagnostics"
export type WorkspaceScreen = "layers" | "push" | "preview" | "settings"

export const WORKSPACE_SCREENS: readonly WorkspaceScreen[] = ["layers", "push", "preview", "settings"]

// `locked`: a push or pull is running on the Push screen. Leaving it would drop the run's results, and a new
// review started before the created keys are linked would offer to create them again (§7.13 rule 10).
export interface NavContext { apiBase: string; settings: FileSettings | null; locked?: boolean }

export interface AppView {
  screen: Screen
  notice: string | null          // shown on the Sign in screen ("Your session ended. Sign in again.")
  signedIn: StoredAuth | null    // the fresh sign-in shown on "Signed in as" (once per sign-in)
}

export type NavEvent =
  | { type: "start-sign-in" }
  | { type: "pairing-approved"; auth: StoredAuth }
  | { type: "pairing-cancelled" }
  | { type: "continue" }
  | { type: "not-me" }
  | { type: "signed-out"; notice: string | null }
  | { type: "project-connected" }
  | { type: "change-project" }
  | { type: "open"; screen: WorkspaceScreen | "diagnostics" }

// A file is usable when its settings belong to this build's server (§7.7 apiBase mismatch → read-only).
export function connectedSettings(context: NavContext): FileSettings | null {
  return context.settings !== null && context.settings.apiBase === context.apiBase ? context.settings : null
}

export function homeScreen(signedIn: boolean, context: NavContext): Screen {
  if (!signedIn) {
    return "sign-in"
  }
  return connectedSettings(context) === null ? "project" : "layers"
}

export function initialView(auth: StoredAuth | null, context: NavContext): AppView {
  return { screen: homeScreen(auth !== null, context), notice: null, signedIn: null }
}

// Nothing is loaded with a fresh token until the designer confirms "Signed in as {email}" (§3.12, D34).
export function awaitingSignInConfirmation(view: Pick<AppView, "screen">): boolean {
  return view.screen === "signed-in"
}

export function isWorkspaceScreen(screen: Screen): screen is WorkspaceScreen {
  return (WORKSPACE_SCREENS as readonly Screen[]).includes(screen)
}

export function navigate(view: AppView, event: NavEvent, context: NavContext): AppView {
  switch (event.type) {
    case "start-sign-in":
      return { screen: "pairing", notice: null, signedIn: null }
    case "pairing-approved":
      return { screen: "signed-in", notice: null, signedIn: event.auth }
    case "pairing-cancelled":
      return { screen: "sign-in", notice: null, signedIn: null }
    case "continue":
      return { screen: homeScreen(true, context), notice: null, signedIn: null }
    case "not-me":
      return { screen: "sign-in", notice: null, signedIn: null }
    case "signed-out":
      return { screen: "sign-in", notice: event.notice, signedIn: null }
    case "project-connected":
      return { screen: "layers", notice: null, signedIn: null }
    case "change-project":
      // "Signed in as" must be answered first (D34): a project the new account can't open must not skip it.
      return view.screen === "signed-in" || context.locked === true ? view : { ...view, screen: "project" }
    case "open":
      if (context.locked === true) {
        return view
      }
      if (event.screen !== "diagnostics" && event.screen !== "settings" && connectedSettings(context) === null) {
        return { ...view, screen: "project" }
      }
      return { ...view, screen: event.screen }
  }
}
