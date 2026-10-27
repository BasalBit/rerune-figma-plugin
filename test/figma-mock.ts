import { vi } from "vitest"

export type FakeText = ReturnType<typeof fakeText>

export function fakeText(id: string, characters: string, extra: Partial<Record<string, unknown>> = {}) {
  const shared = new Map<string, string>()
  const key = (namespace: string, name: string) => namespace + "/" + name
  return {
    id,
    type: "TEXT" as const,
    name: characters,
    characters,
    removed: false,
    visible: true,
    locked: false,
    autoRename: true,
    hasMissingFont: false,
    fontName: { family: "Inter", style: "Regular" },
    parent: null as unknown,
    getRangeAllFontNames: () => [{ family: "Inter", style: "Regular" }],
    getSharedPluginData: (namespace: string, name: string) => shared.get(key(namespace, name)) ?? "",
    setSharedPluginData: (namespace: string, name: string, value: string) => {
      if (value === "") {
        shared.delete(key(namespace, name))
      } else {
        shared.set(key(namespace, name), value)
      }
    },
    getSharedPluginDataKeys: (namespace: string) =>
      [...shared.keys()].filter((entry) => entry.startsWith(namespace + "/")).map((entry) => entry.slice(namespace.length + 1)),
    setRelaunchData: vi.fn(),
    ...extra,
  }
}

export function installFigma(overrides: Record<string, unknown> = {}) {
  const figma = {
    mixed: Symbol("mixed"),
    editorType: "figma",
    mode: "default",
    command: "",
    skipInvisibleInstanceChildren: false,
    notify: vi.fn(),
    openExternal: vi.fn(),
    showUI: vi.fn(),
    loadFontAsync: vi.fn(async () => {}),
    ui: { postMessage: vi.fn(), onmessage: undefined as unknown, resize: vi.fn() },
    clientStorage: {
      getAsync: vi.fn(async () => undefined),
      setAsync: vi.fn(async () => {}),
      deleteAsync: vi.fn(async () => {}),
      keysAsync: vi.fn(async () => []),
    },
    codegen: { on: vi.fn() },
    currentPage: { id: "0:1", name: "Page 1", selection: [], loadAsync: async () => {}, findAllWithCriteria: vi.fn(() => []) },
    root: { name: "File", getSharedPluginData: () => "", setSharedPluginData: vi.fn() },
    getNodeByIdAsync: vi.fn(async () => null),
    ...overrides,
  }
  const globals = globalThis as unknown as Record<string, unknown>
  globals.figma = figma
  globals.__html__ = "/*ui*/"
  return figma
}

export function uninstallFigma(): void {
  const globals = globalThis as unknown as Record<string, unknown>
  delete globals.figma
  delete globals.__html__
  vi.restoreAllMocks()
}
