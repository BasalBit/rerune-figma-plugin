import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fakeComponent, fakeFrame, fakeGroup, fakeInstance, fakeText, installFigma, onPage, uninstallFigma, type FakeNode, type FigmaMock } from "../../test/figma-mock"
import { keyId, PROJECT_ID } from "../../test/fixtures"
import { DATA_KEYS, PLUGIN_DATA_NAMESPACE, STORAGE_KEYS } from "../shared/constants"
import { src } from "../shared/hash"
import { serializeLink } from "../shared/plugin-data"
import { UNCACHED_NOTE } from "../codegen/snippets"
import { codegenCacheKey, saveCodegenCache } from "./auth-storage"
import { codegenKeys, collectLinkedKeys, generateCode, keyLines, MORE_KEYS_LINE, NO_KEY_CODE, registerCodegen } from "./codegen"

let figmaMock: FigmaMock

beforeEach(() => {
  figmaMock = installFigma({ editorType: "dev", mode: "codegen", command: "generate" })
})

afterEach(() => {
  uninstallFigma()
})

function linked(id: string, n: number, name = "key_" + n, nid = id): FakeNode {
  const node = fakeText(id, "Text " + n)
  node.setSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.link, serializeLink({ v: 1, id: keyId(n), k: name, p: PROJECT_ID, src: src("Text " + n), nid, t: 1 }))
  return node
}

function scene(node: FakeNode): SceneNode {
  return node as unknown as SceneNode
}

describe("collectLinkedKeys", () => {
  it("returns the key of a linked text layer", () => {
    expect(collectLinkedKeys(scene(linked("1:1", 1, "checkout_pay_button")))).toEqual({
      keys: [{ keyId: keyId(1), projectId: PROJECT_ID, k: "checkout_pay_button" }],
      more: false,
      complete: true,
    })
  })

  it("collects linked text under a container in order, deduplicated by key, skipping hidden layers", () => {
    const hidden = linked("1:5", 5)
    hidden.visible = false
    const frame = fakeFrame("1:0", "Checkout", [linked("1:1", 1), fakeGroup("1:2", "Group", [linked("1:3", 2), linked("1:4", 1)]), hidden, fakeText("1:6", "Unlinked")])
    expect(collectLinkedKeys(scene(frame)).keys.map((key) => key.k)).toEqual(["key_1", "key_2"])
  })

  it("ignores inherited links whose instance overrides the text, and invalid links", () => {
    const main = linked("5:67", 1)
    const sub = fakeText("I12:34;5:67", "Own text")
    sub.inheritFrom = main
    const broken = fakeText("1:9", "x")
    broken.setSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.link, "{bad")
    const instance = fakeInstance("12:34", "Button", [sub], { overrides: [{ id: "I12:34;5:67", overriddenFields: ["characters"] }] })
    onPage(figmaMock, [fakeComponent("5:1", "Button", [main]), instance, broken])
    expect(collectLinkedKeys(scene(instance)).keys).toEqual([])
    expect(collectLinkedKeys(scene(broken)).keys).toEqual([])
  })

  it("stops at 50 keys and says more exist", () => {
    const frame = fakeFrame("1:0", "Big", Array.from({ length: 52 }, (_, i) => linked("2:" + i, i)))
    const result = collectLinkedKeys(scene(frame))
    expect(result.keys).toHaveLength(50)
    expect(result.more).toBe(true)
  })

  it("stops when the 1.5 s budget is spent", () => {
    const frame = fakeFrame("1:0", "Slow", Array.from({ length: 10 }, (_, i) => linked("2:" + i, i)))
    let time = 0
    const clock = () => {
      time += 400
      return time
    }
    const result = collectLinkedKeys(scene(frame), clock)
    expect(result.more).toBe(true)
    expect(result.complete).toBe(false)
    expect(result.keys.length).toBeLessThan(10)
  })
})

describe("keyLines", () => {
  it("prefers the cached key name and adds the cached source text as a comment", () => {
    const keys = [
      { keyId: keyId(1), projectId: PROJECT_ID, k: "old_name" },
      { keyId: keyId(2), projectId: PROJECT_ID, k: "uncached" },
    ]
    const cache = new Map([[PROJECT_ID, { [keyId(1)]: { k: "checkout_pay_button", placeholders: [], sourceText: "Pay\nnow", updatedAt: 1 } }]])
    expect(keyLines(keys, cache, true)).toEqual(["// Pay now", "checkout_pay_button", "uncached", MORE_KEYS_LINE])
  })
})

describe("codegenKeys", () => {
  it("takes name, placeholders and source text from the cache, else the link's name", () => {
    const keys = [
      { keyId: keyId(1), projectId: PROJECT_ID, k: "old_name" },
      { keyId: keyId(2), projectId: PROJECT_ID, k: "uncached" },
    ]
    const cache = new Map([[PROJECT_ID, { [keyId(1)]: { k: "greeting", placeholders: ["name"], sourceText: "Hi {{name}}", updatedAt: 1 } }]])
    expect(codegenKeys(keys, cache)).toEqual({
      keys: [
        { name: "greeting", placeholders: ["name"], sourceText: "Hi {{name}}" },
        { name: "uncached", placeholders: [], sourceText: null },
      ],
      uncached: true,
    })
    expect(codegenKeys(keys.slice(0, 1), cache).uncached).toBe(false)
  })
})

describe("generateCode", () => {
  it("answers platform snippets and reads the project cache once per call", async () => {
    figmaMock.clientStorage.data.set(codegenCacheKey(PROJECT_ID), {
      [keyId(1)]: { k: "renamed_in_rerune", placeholders: [], sourceText: "Text 1", updatedAt: 1 },
      [keyId(2)]: { k: "greeting", placeholders: ["name", "count"], sourceText: "Hi {{name}}", updatedAt: 1 },
    })
    const frame = fakeFrame("1:0", "Checkout", [linked("1:1", 1), linked("1:2", 2)])
    const result = await generateCode({ node: scene(frame), language: "flutter" }, "production")
    expect(result).toEqual([
      {
        title: "ReRune keys",
        language: "PLAINTEXT",
        code: "// Text 1\nAppLocalizations.of(context)!.renamed_in_rerune\n\n// Hi {{name}}\nAppLocalizations.of(context)!.greeting(name, count)",
      },
    ])
    expect(figmaMock.clientStorage.getAsync.mock.calls.filter((call) => call[0] === codegenCacheKey(PROJECT_ID))).toHaveLength(1)
  })

  it.each([
    ["react-i18next", "TYPESCRIPT", "t('checkout_pay_button')"],
    ["flutter", "PLAINTEXT", "AppLocalizations.of(context)!.checkout_pay_button"],
    ["android", "KOTLIN", "stringResource(R.string.checkout_pay_button)\n// Views: getString(R.string.checkout_pay_button)"],
    ["ios", "SWIFT", 'Text(NSLocalizedString("checkout_pay_button", comment: ""))\n// UIKit: NSLocalizedString("checkout_pay_button", comment: "")'],
    ["angular", "HTML", "{{ 'checkout_pay_button' | translate }}\n<!-- Transloco: {{ 'checkout_pay_button' | transloco }} -->"],
  ])("answers %s with its CodegenResult language", async (language, resultLanguage, code) => {
    figmaMock.clientStorage.data.set(codegenCacheKey(PROJECT_ID), {
      [keyId(1)]: { k: "checkout_pay_button", placeholders: [], sourceText: "", updatedAt: 1 },
    })
    expect(await generateCode({ node: scene(linked("1:1", 1, "checkout_pay_button")), language }, "production")).toEqual([
      { title: "ReRune keys", language: resultLanguage, code },
    ])
  })

  it("uses the link's key name and says how to load placeholders when the cache has no entry", async () => {
    const result = await generateCode({ node: scene(linked("1:1", 1, "checkout.pay")), language: "android" }, "production")
    expect(result[0].code).toBe("stringResource(R.string.checkout_pay)\n// Views: getString(R.string.checkout_pay)\n\n// " + UNCACHED_NOTE)
  })

  it("uses what the inspect panel saved (cache-save) for names and placeholders", async () => {
    await saveCodegenCache(PROJECT_ID, [{ keyId: keyId(1), k: "greeting", placeholders: ["name"], sourceText: "Hello {{name}}" }], 5)
    const result = await generateCode({ node: scene(linked("1:1", 1, "old_name")), language: "ios" }, "production")
    expect(result[0]).toEqual({
      title: "ReRune keys",
      language: "SWIFT",
      code: '// Hello {{name}}\nString(format: NSLocalizedString("greeting", comment: ""), name)',
    })
  })

  it("stops at 50 keys with the More keys line as a comment", async () => {
    const frame = fakeFrame("1:0", "Big", Array.from({ length: 52 }, (_, i) => linked("2:" + i, i)))
    const result = await generateCode({ node: scene(frame), language: "angular" }, "production")
    const code = result[0].code
    expect(code.match(/\| translate }}/g)).toHaveLength(50)
    expect(code).toContain("<!-- " + MORE_KEYS_LINE + " -->")
  })

  it("keeps key names as PLAINTEXT for a language the manifest does not list", async () => {
    figmaMock.clientStorage.data.set(codegenCacheKey(PROJECT_ID), {
      [keyId(1)]: { k: "renamed_in_rerune", placeholders: [], sourceText: "Text 1", updatedAt: 1 },
    })
    const frame = fakeFrame("1:0", "Checkout", [linked("1:1", 1), linked("1:2", 2)])
    expect(await generateCode({ node: scene(frame), language: "cobol" }, "production")).toEqual([
      { title: "ReRune keys", language: "PLAINTEXT", code: "// Text 1\nrenamed_in_rerune\nkey_2" },
    ])
  })

  it("says when no key is linked", async () => {
    expect(await generateCode({ node: scene(fakeText("1:1", "Plain")), language: "ios" }, "production")).toEqual([
      { title: "ReRune", language: "PLAINTEXT", code: NO_KEY_CODE },
    ])
    expect(await generateCode({ node: scene(fakeFrame("1:0", "Empty")), language: "ios" }, "production")).toEqual([
      { title: "ReRune", language: "PLAINTEXT", code: NO_KEY_CODE },
    ])
  })

  it("never calls the network", async () => {
    const fetchSpy = vi.fn()
    ;(globalThis as unknown as Record<string, unknown>).fetch = fetchSpy
    await generateCode({ node: scene(linked("1:1", 1)), language: "android" }, "production")
    expect(fetchSpy).not.toHaveBeenCalled()
    delete (globalThis as unknown as Record<string, unknown>).fetch
  })

  it("returns the T6 report for the diagnostics language in development builds only", async () => {
    const node = linked("1:1", 1)
    const report = await generateCode({ node: scene(node), language: "rerune-diagnostics" }, "development")
    expect(report[0].title).toBe("ReRune diagnostics")
    expect(report[0].code).toContain('figma.mode: "codegen"')
    expect(report[0].code).toContain('figma.command: "generate"')
    expect(report[0].code).toContain("skipInvisibleInstanceChildren: false")
    expect(report[0].code).toContain("cache read ms:")
    expect(report[0].code).toContain("snippet build ms:")
    const production = await generateCode({ node: scene(node), language: "rerune-diagnostics" }, "production")
    expect(production[0]).toEqual({ title: "ReRune keys", language: "PLAINTEXT", code: "key_1" })
  })

  it("waits for a layer named sleep:<n> before reporting", async () => {
    vi.useFakeTimers()
    try {
      const node = fakeFrame("1:0", "sleep:2")
      let settled = false
      const pending = generateCode({ node: scene(node), language: "rerune-diagnostics" }, "development").then((result) => {
        settled = true
        return result
      })
      await vi.advanceTimersByTimeAsync(1999)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      const report = await pending
      expect(report[0].code).toContain("slept seconds: 2")
    } finally {
      vi.useRealTimers()
    }
  })

  it("registers the generate handler", async () => {
    registerCodegen()
    expect(figmaMock.codegen.on).toHaveBeenCalledWith("generate", expect.any(Function))
    const handler = figmaMock.codegen.on.mock.calls[0][1] as (event: CodegenEvent) => Promise<CodegenResult[]>
    expect(await handler({ node: scene(linked("1:1", 1, "checkout_pay_button")), language: "react-i18next" })).toEqual([
      { title: "ReRune keys", language: "TYPESCRIPT", code: "t('checkout_pay_button')\n\n// " + UNCACHED_NOTE },
    ])
    expect(figmaMock.clientStorage.data.has(STORAGE_KEYS.codegenIndex)).toBe(false)
  })
})
