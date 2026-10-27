// Small static analysis over the plugin's own sources (read as text through import.meta.glob), used by the
// whole-repo consistency tests. It understands just enough TypeScript for this codebase: relative imports and
// re-exports, type-only imports, and top-level declarations that start at column 0.

export type Sources = Record<string, string>

export interface ImportEdge { target: string; names: string[] }

// "../src/ui/state/../../shared/x" → "../src/shared/x" (glob keys keep their leading "../").
export function normalizePath(path: string): string {
  const out: string[] = []
  for (const part of path.split("/")) {
    if (part === "" || part === ".") {
      continue
    }
    if (part === ".." && out.length > 0 && out[out.length - 1] !== "..") {
      out.pop()
    } else {
      out.push(part)
    }
  }
  return out.join("/")
}

// Glob results with normalised keys, so they match resolved import paths.
export function normalizeSources(glob: Record<string, string>): Sources {
  const sources: Sources = {}
  for (const [path, source] of Object.entries(glob)) {
    sources[normalizePath(path)] = source
  }
  return sources
}

export function resolveImport(sources: Sources, from: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) {
    return null
  }
  const slash = from.lastIndexOf("/")
  const base = normalizePath((slash < 0 ? "" : from.slice(0, slash)) + "/" + specifier)
  for (const candidate of [base, base + ".ts", base + ".tsx", base + "/index.ts"]) {
    if (Object.prototype.hasOwnProperty.call(sources, candidate)) {
      return candidate
    }
  }
  return null
}

// `import X, { a, type T, b as c } from "…"`, `import * as ns from "…"`, `export { a } from "…"`, `export * from "…"`.
const IMPORT_OR_REEXPORT = /^(import|export)\s+(type\s+)?((?:\w+\s*,\s*)?(?:\{[^}]*\}|\*(?:\s+as\s+\w+)?|\w+))\s+from\s+["']([^"']+)["']/gm
const SIDE_EFFECT_IMPORT = /^import\s+["']([^"']+)["']/gm

// Value names a clause brings in ("type X" members and "import type" clauses bring none).
function valueNames(clause: string): string[] {
  const names: string[] = []
  const braces = /\{([\s\S]*)\}/.exec(clause)
  const outside = braces === null ? clause : clause.slice(0, braces.index) + clause.slice(braces.index + braces[0].length)
  for (const part of outside.split(",").map((entry) => entry.trim()).filter((entry) => entry !== "")) {
    const namespace = /^\*\s+as\s+(\w+)$/.exec(part)
    names.push(namespace !== null ? "*" : part)
  }
  if (braces !== null) {
    for (const member of braces[1].split(",").map((entry) => entry.trim()).filter((entry) => entry !== "")) {
      if (member.startsWith("type ")) {
        continue
      }
      names.push(member.split(/\s+as\s+/)[0].trim())
    }
  }
  return names
}

// Runtime imports of a file: each relative module it imports values from (or re-exports), with the names used.
export function runtimeImports(sources: Sources, file: string): ImportEdge[] {
  const source = sources[file]
  const edges: ImportEdge[] = []
  for (const match of source.matchAll(IMPORT_OR_REEXPORT)) {
    const typeOnly = match[2] !== undefined
    const target = resolveImport(sources, file, match[4])
    if (typeOnly || target === null) {
      continue
    }
    const names = valueNames(match[3])
    if (names.length > 0) {
      edges.push({ target, names })
    }
  }
  for (const match of source.matchAll(SIDE_EFFECT_IMPORT)) {
    const target = resolveImport(sources, file, match[1])
    if (target !== null) {
      edges.push({ target, names: ["*"] })
    }
  }
  return edges
}

// Every file whose code is bundled because `entry` imports values from it, directly or indirectly.
export function importClosure(sources: Sources, entry: string): string[] {
  const seen = new Set<string>()
  const stack = [entry]
  while (stack.length > 0) {
    const file = stack.pop() as string
    if (seen.has(file)) {
      continue
    }
    seen.add(file)
    for (const edge of runtimeImports(sources, file)) {
      stack.push(edge.target)
    }
  }
  return [...seen].sort()
}

// Value names that files of `closure` import from `target`.
export function namesImportedFrom(sources: Sources, closure: readonly string[], target: string): string[] {
  const names = new Set<string>()
  for (const file of closure) {
    for (const edge of runtimeImports(sources, file)) {
      if (edge.target === target) {
        edge.names.forEach((name) => names.add(name))
      }
    }
  }
  return [...names].sort()
}

const DECLARATION = /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?(function\*?|const|let|class|interface|type|enum)\s+(\w+)/gm

// The text of each top-level value declaration (function, const, let, class), up to the next top-level
// declaration of any kind. Types and interfaces only end the previous chunk: they hold no runtime code, and their
// text (`{ type: "link-apply"; … }` in a union) must not count as building a message.
export function declarations(source: string): Map<string, string> {
  const starts = [...source.matchAll(DECLARATION)].map((match) => ({
    kind: match[1],
    name: match[2],
    index: match.index ?? 0,
  }))
  const result = new Map<string, string>()
  starts.forEach((start, i) => {
    if (start.kind === "interface" || start.kind === "type") {
      return
    }
    const end = i + 1 < starts.length ? starts[i + 1].index : source.length
    result.set(start.name, (result.get(start.name) ?? "") + source.slice(start.index, end))
  })
  return result
}

// The code reachable inside one file from the given names: their declarations plus every top-level declaration
// they mention, transitively. "*" (namespace or side-effect import) means the whole file.
export function codeReachableFrom(source: string, names: readonly string[]): string {
  if (names.includes("*")) {
    return source
  }
  const all = declarations(source)
  const reached = new Set<string>()
  const stack = names.filter((name) => all.has(name))
  while (stack.length > 0) {
    const name = stack.pop() as string
    if (reached.has(name)) {
      continue
    }
    reached.add(name)
    const text = all.get(name) as string
    for (const other of all.keys()) {
      if (!reached.has(other) && new RegExp("\\b" + other + "\\b").test(text)) {
        stack.push(other)
      }
    }
  }
  return [...reached].map((name) => all.get(name) as string).join("\n")
}

// Message types the code builds as object literals (`{ type: "link-apply", … }`), from a list of known types.
export function builtMessageTypes(code: string, types: readonly string[]): string[] {
  return types.filter((type) => code.includes(`type: "${type}"`))
}
