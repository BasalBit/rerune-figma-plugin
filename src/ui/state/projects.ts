import type { FigmaProject } from "../../shared/api-types"

// Project list helpers for the Project screen (E8).

const PERMISSION_LABELS: Record<string, string> = {
  edit_keys: "Edit keys",
  publishing: "Publish",
  project_settings: "Settings",
}

export function permissionLabel(permission: string): string {
  return PERMISSION_LABELS[permission] ?? permission.replace(/_/g, " ")
}

export function groupProjects(projects: readonly FigmaProject[], query: string): { organisation: string; projects: FigmaProject[] }[] {
  const needle = query.trim().toLowerCase()
  const groups = new Map<string, { organisation: string; projects: FigmaProject[] }>()
  for (const project of projects) {
    if (needle !== "" && !project.name.toLowerCase().includes(needle) && !project.organisation.name.toLowerCase().includes(needle)) {
      continue
    }
    let group = groups.get(project.organisation.id)
    if (group === undefined) {
      group = { organisation: project.organisation.name, projects: [] }
      groups.set(project.organisation.id, group)
    }
    group.projects.push(project)
  }
  return [...groups.values()]
}
