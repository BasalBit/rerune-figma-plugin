import { describe, expect, it } from "vitest"
import type { FigmaProject } from "../../shared/api-types"
import { groupProjects, permissionLabel } from "./projects"

function project(id: string, name: string, org: string, permissions: string[] = []): FigmaProject {
  return { id, name, organisation: { id: "o-" + org, name: org }, main_language: "en", languages: [], variation_options: [], permissions }
}

describe("projects", () => {
  const projects = [project("1", "Chapter", "Ada's Org"), project("2", "Website", "Ada's Org"), project("3", "Chapter", "BasalBit")]

  it("groups by organisation in server order and filters by name", () => {
    expect(groupProjects(projects, "").map((group) => [group.organisation, group.projects.map((entry) => entry.id)])).toEqual([
      ["Ada's Org", ["1", "2"]],
      ["BasalBit", ["3"]],
    ])
    expect(groupProjects(projects, " web ").map((group) => group.projects.map((entry) => entry.id))).toEqual([["2"]])
    expect(groupProjects(projects, "basal").map((group) => group.organisation)).toEqual(["BasalBit"])
  })

  it("labels permissions", () => {
    expect(permissionLabel("edit_keys")).toBe("Edit keys")
    expect(permissionLabel("manage_members")).toBe("manage members")
  })
})
