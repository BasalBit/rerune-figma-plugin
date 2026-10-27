import { describe, expect, it } from "vitest"
import { keyId, linkedNode, OTHER_PROJECT_ID, PROJECT_ID, scannedNode } from "../../test/fixtures"
import type { FigmaKeyRef, FigmaPushResult } from "./api-types"
import { src } from "./hash"
import { KEY_NAME_ISSUES, createKeyNameSuggester, nameSourceOf } from "./key-names"
import type { ScannedNode, Scope } from "./messages"
import {
  applyDecision,
  buildPushPlan,
  canPush,
  failureMessage,
  planLinkApplies,
  planPullApplies,
  planTextApplies,
  planToRequests,
  planUnlinks,
  pushFollowUp,
  withNameIssues,
  writeTargets,
  type PlanContext,
  type PushPlan,
  type RemoteWithMaxLength,
} from "./push-plan"

const K1 = keyId(1)
const K2 = keyId(2)
const K3 = keyId(3)

function remoteState(key: string, mainText: string | null, overrides: Partial<RemoteWithMaxLength> = {}): RemoteWithMaxLength {
  return { found: true, key, type: "key", enabled: true, structured: false, mainText, maxLength: null, ...overrides }
}

function setup(
  nodes: ScannedNode[],
  options: {
    remote?: [string, RemoteWithMaxLength][]
    textMatches?: [string, FigmaKeyRef[]][]
    scope?: Scope
    group?: boolean
    taken?: string[]
  } = {},
) {
  const remote = new Map(options.remote ?? [])
  const suggester = createKeyNameSuggester({ style: "snake", template: null, taken: options.taken ?? [] })
  const suggestName = (node: ScannedNode) => suggester.suggest(nameSourceOf(node))
  const plan = buildPushPlan({
    projectId: PROJECT_ID,
    scope: options.scope ?? "selection",
    nodes,
    remote,
    textMatches: new Map(options.textMatches ?? []),
    groupIdenticalTexts: options.group ?? true,
    suggestName,
  })
  const context: PlanContext = {
    projectId: PROJECT_ID,
    nodes: new Map(nodes.map((node) => [node.nodeId, node])),
    remote,
    style: "snake",
    isTaken: (name) => (options.taken ?? []).includes(name),
    suggestName,
  }
  return { plan, context }
}

function linked(nodeId: string, text: string, key: string, synced: string, extra: { nid?: string; state?: ScannedNode["linkState"]; projectId?: string } = {}, overrides: Partial<ScannedNode> = {}) {
  return linkedNode(nodeId, text, { keyId: key, keyName: "key_" + key.slice(-1), syncedText: synced, ...extra }, overrides)
}

describe("rule 1: active previews block the push", () => {
  it("lists previewed nodes and refuses to build requests", () => {
    const node = scannedNode("1:1", "Jetzt zahlen", {
      originalCharacters: "Pay now",
      name: "Pay button",
      autoRename: false,
      preview: { lang: "de", source: "draft", variationOptionId: null, appliedAt: 1 },
    })
    const { plan } = setup([node, scannedNode("1:2", "Cancel")])
    expect(plan.blockedByPreview).toEqual(["1:1"])
    expect(canPush(plan)).toBe(false)
    expect(planToRequests(plan)).toEqual([])
    expect(plan.creates[0].text).toBe("Pay now")
  })
})

describe("rule 2: unlinked layers become creates", () => {
  it("groups identical normalised texts into one key with short refs", () => {
    const nodes = [
      scannedNode("1:1", "Pay now", { name: "Pay button", autoRename: false }),
      scannedNode("1:2", " Pay now\r\n", { frameName: "Cart" }),
      scannedNode("1:3", "Cancel", { frameName: null }),
    ]
    const { plan } = setup(nodes)
    expect(plan.creates).toEqual([
      {
        ref: "c0",
        nodeIds: ["1:1", "1:2"],
        text: "Pay now",
        name: "checkout_pay_button",
        nameIssues: [],
        description: "Checkout",
        selected: true,
        match: { candidates: [], decision: "create", linkKeyId: null },
        origin: { kind: "unlinked" },
      },
      {
        ref: "c1",
        nodeIds: ["1:3"],
        text: "Cancel",
        name: "mobile_cancel",
        nameIssues: [],
        description: "",
        selected: true,
        match: { candidates: [], decision: "create", linkKeyId: null },
        origin: { kind: "unlinked" },
      },
    ])
  })

  it("creates one key per layer when grouping is off", () => {
    const { plan } = setup([scannedNode("1:1", "Pay now"), scannedNode("1:2", "Pay now")], { group: false })
    expect(plan.creates.map((create) => [create.ref, create.nodeIds, create.name])).toEqual([
      ["c0", ["1:1"], "checkout_pay_now"],
      ["c1", ["1:2"], "checkout_pay_now_2"],
    ])
  })

  it("selects creates by default only for the selection scope", () => {
    expect(setup([scannedNode("1:1", "Pay now")], { scope: "page" }).plan.creates[0].selected).toBe(false)
    expect(setup([scannedNode("1:1", "Pay now")], { scope: "selection" }).plan.creates[0].selected).toBe(true)
  })

  it("treats inherited_overridden layers as unlinked", () => {
    const node = linked("I1:2;5:67", "Bezahlen", K1, "Pay now", { nid: "5:67", state: "inherited_overridden" })
    const { plan } = setup([node], { remote: [[K1, remoteState("key_1", "Pay now")]] })
    expect(plan.creates.map((create) => create.nodeIds)).toEqual([["I1:2;5:67"]])
  })

  it("defaults to linking a single exact text match", () => {
    const { plan, context } = setup([scannedNode("1:1", "Pay now")], { textMatches: [["Pay now", [{ id: K1, key: "checkout_pay_button" }]]] })
    expect(plan.creates[0].match).toEqual({ candidates: [{ id: K1, key: "checkout_pay_button" }], decision: "link", linkKeyId: K1 })
    expect(planToRequests(plan)).toEqual([])
    expect(planLinkApplies(plan, context)).toEqual([{ nodeId: "1:1", keyId: K1, keyName: "checkout_pay_button", projectId: PROJECT_ID, src: src("Pay now") }])
  })

  it("leaves several matches undecided and excluded", () => {
    const candidates = [
      { id: K1, key: "a" },
      { id: K2, key: "b" },
    ]
    const { plan, context } = setup([scannedNode("1:1", "Pay now")], { textMatches: [["Pay now", candidates]] })
    expect(plan.creates[0].match).toEqual({ candidates, decision: null, linkKeyId: null })
    expect(planToRequests(plan)).toEqual([])
    expect(planLinkApplies(plan, context)).toEqual([])
    const picked = applyDecision(plan, { kind: "create-match", ref: "c0", decision: "link", key: candidates[1] }, context)
    expect(planLinkApplies(picked, context).map((item) => item.keyId)).toEqual([K2])
    // A key whose text was not matched (e.g. a taken name) never links with src(layer text) from the plan (§7.11).
    const other = applyDecision(picked, { kind: "create-match", ref: "c0", decision: "link", key: { id: K3, key: "checkout_pay_now" } }, context)
    expect(other.creates[0].match).toEqual(picked.creates[0].match)
    expect(planLinkApplies(other, context).map((item) => item.keyId)).toEqual([K2])
    const created = applyDecision(plan, { kind: "create-match", ref: "c0", decision: "create" }, context)
    expect(planToRequests(created)[0].items).toEqual([
      { client_ref: "c0", op: "create", key: "checkout_pay_now", text: "Pay now", description: "Checkout", max_length: null },
    ])
  })

  it("creates when there is no exact match", () => {
    const { plan } = setup([scannedNode("1:1", "Pay now")], { textMatches: [["Other", [{ id: K1, key: "x" }]]] })
    expect(plan.creates[0].match.decision).toBe("create")
  })

  it("skips layers whose text is empty", () => {
    expect(setup([scannedNode("1:1", "  \n ")]).plan.creates).toEqual([])
  })
})

describe("rule 3: changed and synced layers grouped by key", () => {
  it("updates a key when every layer has the same changed text", () => {
    const nodes = [linked("1:1", "Pay securely", K1, "Pay now"), linked("1:2", "Pay securely", K1, "Pay now")]
    const { plan } = setup(nodes, { remote: [[K1, remoteState("checkout_pay_button", "Pay now ")]] })
    expect(plan.updates).toEqual([
      { ref: "u" + K1, keyId: K1, keyName: "checkout_pay_button", nodeIds: ["1:1", "1:2"], text: "Pay securely", expectedText: "Pay now ", origin: { kind: "changed" } },
    ])
    expect(planToRequests(plan)[0].items).toEqual([{ client_ref: "u" + K1, op: "update", key_id: K1, text: "Pay securely", expected_text: "Pay now " }])
  })

  it("counts all-synced keys as unchanged", () => {
    const nodes = [linked("1:1", "Pay now", K1, "Pay now"), linked("1:2", "Pay now", K1, "Pay now")]
    const { plan } = setup(nodes, { remote: [[K1, remoteState("k", "Pay now")]] })
    expect(plan.updates).toEqual([])
    expect(plan.unchanged).toBe(2)
  })

  it("sends an empty expected text when the key has no main value", () => {
    const { plan } = setup([linked("1:1", "Pay now", K1, "")], { remote: [[K1, remoteState("k", null)]] })
    expect(plan.updates[0].expectedText).toBe("")
  })

  it("reports divergent texts and lets the designer pick a winner", () => {
    const nodes = [linked("1:1", "Pay now", K1, "Pay now"), linked("1:2", "Pay securely", K1, "Pay now"), linked("1:3", "Pay today", K1, "Pay now")]
    const { plan, context } = setup(nodes, { remote: [[K1, remoteState("checkout_pay_button", "Pay now")]] })
    expect(plan.divergent).toEqual([
      {
        keyId: K1,
        keyName: "checkout_pay_button",
        remoteText: "Pay now",
        variants: [
          { text: "Pay now", nodeIds: ["1:1"], decision: null },
          { text: "Pay securely", nodeIds: ["1:2"], decision: null },
          { text: "Pay today", nodeIds: ["1:3"], decision: null },
        ],
      },
    ])
    expect(planToRequests(plan)).toEqual([])

    let next = applyDecision(plan, { kind: "divergent", keyId: K1, variant: 1, decision: "winner" }, context)
    next = applyDecision(next, { kind: "divergent", keyId: K1, variant: 2, decision: "new_key" }, context)
    next = applyDecision(next, { kind: "divergent", keyId: K1, variant: 0, decision: "leave" }, context)
    expect(next.updates).toEqual([
      { ref: "u" + K1, keyId: K1, keyName: "checkout_pay_button", nodeIds: ["1:2"], text: "Pay securely", expectedText: "Pay now", origin: { kind: "divergent", variant: 1 } },
    ])
    expect(next.creates.map((create) => [create.ref, create.name, create.nodeIds, create.text, create.selected])).toEqual([
      ["c0", "checkout_pay_button_2", ["1:3"], "Pay today", true],
    ])
    expect(planToRequests(next)[0].items.map((item) => item.client_ref)).toEqual(["c0", "u" + K1])

    const switched = applyDecision(next, { kind: "divergent", keyId: K1, variant: 2, decision: "winner" }, context)
    expect(switched.divergent[0].variants.map((variant) => variant.decision)).toEqual(["leave", null, "winner"])
    expect(switched.updates.map((update) => update.text)).toEqual(["Pay today"])
    expect(switched.creates).toEqual([])
  })

  it("counts identical texts across synced and changed layers as one update", () => {
    const nodes = [linked("1:1", "Pay securely", K1, "Pay now"), linked("1:2", "Pay securely", K1, "Pay securely")]
    const { plan } = setup(nodes, { remote: [[K1, remoteState("k", "Pay now")]] })
    expect(plan.updates.map((update) => update.nodeIds)).toEqual([["1:1"]])
    expect(plan.pulls.map((pull) => pull.nodeIds)).toEqual([["1:2"]])
  })
})

describe("rule 4: conflicts", () => {
  const nodes = [linked("1:1", "Pay securely", K1, "Pay now")]
  const remote: [string, RemoteWithMaxLength][] = [[K1, remoteState("k", "Pay safely")]]

  it("skips by default", () => {
    const { plan } = setup(nodes, { remote })
    expect(plan.conflicts).toEqual([{ keyId: K1, keyName: "k", nodeIds: ["1:1"], figmaText: "Pay securely", remoteText: "Pay safely", decision: "skip" }])
    expect(planToRequests(plan)).toEqual([])
  })

  it("overwrites with the current remote text as expected text", () => {
    const { plan, context } = setup(nodes, { remote })
    const next = applyDecision(plan, { kind: "conflict", keyId: K1, figmaText: "Pay securely", decision: "overwrite" }, context)
    expect(planToRequests(next)[0].items).toEqual([{ client_ref: "u" + K1, op: "update", key_id: K1, text: "Pay securely", expected_text: "Pay safely" }])
    const skipped = applyDecision(next, { kind: "conflict", keyId: K1, figmaText: "Pay securely", decision: "skip" }, context)
    expect(skipped.updates).toEqual([])
  })

  it("takes the ReRune text through text-apply", () => {
    const { plan, context } = setup(nodes, { remote })
    const next = applyDecision(plan, { kind: "conflict", keyId: K1, figmaText: "Pay securely", decision: "take_rerune" }, context)
    expect(next.updates).toEqual([])
    expect(planTextApplies(next, context)).toEqual([{ nodeId: "1:1", text: "Pay safely", src: src("Pay safely") }])
  })

  it("gives a second update for the same key a unique ref", () => {
    const both = [linked("1:1", "Pay securely", K1, "Pay now"), linked("1:2", "Pay later", K1, "Pay now")]
    const { plan, context } = setup(both, { remote })
    let next = applyDecision(plan, { kind: "conflict", keyId: K1, figmaText: "Pay securely", decision: "overwrite" }, context)
    next = applyDecision(next, { kind: "conflict", keyId: K1, figmaText: "Pay later", decision: "overwrite" }, context)
    expect(next.updates.map((update) => update.ref)).toEqual(["u" + K1, "u" + K1 + "-2"])
  })
})

describe("rule 5: pulls", () => {
  it("collects changed_in_rerune layers outside the push request", () => {
    const { plan } = setup([linked("1:1", "Pay now", K1, "Pay now")], { remote: [[K1, remoteState("k", "Pay securely")]] })
    expect(plan.pulls).toEqual([{ keyId: K1, keyName: "k", nodeIds: ["1:1"], remoteText: "Pay securely" }])
    expect(planToRequests(plan)).toEqual([])
    expect(planPullApplies(plan)).toEqual([{ nodeId: "1:1", text: "Pay securely", src: src("Pay securely") }])
  })

  it("targets each main component once instead of every inherited instance", () => {
    const nodes = [
      linked("I1:1;5:67", "Pay now", K1, "Pay now", { nid: "5:67", state: "inherited" }),
      linked("I1:2;5:67", "Pay now", K1, "Pay now", { nid: "5:67", state: "inherited" }),
      linked("I1:3;8:1", "Pay now", K1, "Pay now", { nid: "8:1", state: "inherited" }),
      linked("8:1", "Pay now", K1, "Pay now"),
    ]
    const { plan } = setup(nodes, { remote: [[K1, remoteState("k", "Pay securely")]] })
    expect(plan.pulls[0].nodeIds).toEqual(["I1:1;5:67", "8:1"])
  })
})

describe("rule 6: copied links", () => {
  const copiedNode = linked("1:9", "Pay now", K1, "Pay now", { nid: "1:1", state: "copied" })

  it("excludes undecided copies", () => {
    const { plan, context } = setup([copiedNode], { remote: [[K1, remoteState("checkout_pay_button", "Pay now")]] })
    expect(plan.copied).toEqual([{ nodeId: "1:9", keyId: K1, keyName: "checkout_pay_button", decision: null }])
    expect(planToRequests(plan)).toEqual([])
    expect(planLinkApplies(plan, context)).toEqual([])
  })

  it("keeps a copy by rewriting the link with the stored src", () => {
    const { plan, context } = setup([copiedNode], { remote: [[K1, remoteState("checkout_pay_button", "Pay now")]] })
    const next = applyDecision(plan, { kind: "copied", nodeId: "1:9", decision: "keep" }, context)
    expect(planLinkApplies(next, context)).toEqual([{ nodeId: "1:9", keyId: K1, keyName: "checkout_pay_button", projectId: PROJECT_ID, src: src("Pay now") }])
  })

  it("turns a copy into a new key", () => {
    const { plan, context } = setup([copiedNode], { remote: [[K1, remoteState("checkout_pay_button", "Pay now")]] })
    const next = applyDecision(plan, { kind: "copied", nodeId: "1:9", decision: "new_key" }, context)
    expect(next.creates.map((create) => [create.nodeIds, create.text, create.name, create.origin])).toEqual([
      [["1:9"], "Pay now", "checkout_pay_now", { kind: "copied", nodeId: "1:9" }],
    ])
    expect(applyDecision(next, { kind: "copied", nodeId: "1:9", decision: null }, context).creates).toEqual([])
  })
})

describe("rule 7: missing keys", () => {
  const nodes = [linked("1:1", "Pay now", K1, "Pay now"), linked("1:2", "Pay now", K1, "Pay now")]
  const remote: [string, RemoteWithMaxLength][] = [[K1, { ...remoteState("x", null), found: false, key: null }]]

  it("skips by default", () => {
    const { plan } = setup(nodes, { remote })
    expect(plan.missing).toEqual([{ keyId: K1, keyName: "key_1", nodeIds: ["1:1", "1:2"], text: "Pay now", decision: "skip" }])
    expect(planToRequests(plan)).toEqual([])
  })

  it("recreates with the stored key name", () => {
    const { plan, context } = setup(nodes, { remote })
    const next = applyDecision(plan, { kind: "missing", keyId: K1, decision: "recreate" }, context)
    expect(planToRequests(next)[0].items).toEqual([{ client_ref: "c0", op: "create", key: "key_1", text: "Pay now", description: "Checkout", max_length: null }])
  })

  it("unlinks", () => {
    const { plan, context } = setup(nodes, { remote })
    const next = applyDecision(plan, { kind: "missing", keyId: K1, decision: "unlink" }, context)
    expect(planUnlinks(next)).toEqual(["1:1", "1:2"])
    expect(next.creates).toEqual([])
  })
})

describe("rule 8: never pushed", () => {
  it("counts readonly, other-project, invalid and unknown layers", () => {
    const nodes = [
      linked("1:1", "A", K1, "A"),
      linked("1:2", "B", K2, "B"),
      linked("1:3", "C", K3, "C", { projectId: OTHER_PROJECT_ID }),
      scannedNode("1:4", "D", { linkState: "invalid" }),
      linked("1:5", "E", keyId(9), "E"),
    ]
    const { plan } = setup(nodes, {
      remote: [
        [K1, remoteState("a", "A", { enabled: false })],
        [K2, remoteState("b", "B", { structured: true })],
      ],
    })
    expect([plan.readonly, plan.otherProject, plan.invalid, plan.unknown]).toEqual([2, 1, 1, 1])
    expect(planToRequests(plan)).toEqual([])
  })
})

describe("rule 9: client-side checks", () => {
  it("blocks updates longer than max_length", () => {
    const { plan } = setup([linked("1:1", "Pay securely now", K1, "Pay now")], { remote: [[K1, remoteState("k", "Pay now", { maxLength: 10 })]] })
    expect(plan.maxLengthViolations).toEqual([{ ref: "u" + K1, length: 16, maxLength: 10 }])
    expect(planToRequests(plan)).toEqual([])
  })

  it("blocks invalid, duplicate and taken names", () => {
    const nodes = [scannedNode("1:1", "Pay now"), scannedNode("1:2", "Cancel")]
    const { plan, context } = setup(nodes, { taken: ["taken_name"] })
    let next = applyDecision(plan, { kind: "create-name", ref: "c0", name: "bad name" }, context)
    expect(next.creates[0].nameIssues).toEqual([KEY_NAME_ISSUES.invalid])
    next = applyDecision(next, { kind: "create-name", ref: "c0", name: "same" }, context)
    next = applyDecision(next, { kind: "create-name", ref: "c1", name: "same" }, context)
    expect(next.creates.map((create) => create.nameIssues)).toEqual([[KEY_NAME_ISSUES.duplicate], [KEY_NAME_ISSUES.duplicate]])
    expect(planToRequests(next)).toEqual([])
    next = applyDecision(next, { kind: "create-selected", ref: "c1", selected: false }, context)
    expect(next.creates[0].nameIssues).toEqual([])
    next = applyDecision(next, { kind: "create-name", ref: "c0", name: "taken_name" }, context)
    expect(next.creates[0].nameIssues).toEqual([KEY_NAME_ISSUES.taken])
    expect(withNameIssues(next, () => false).creates[0].nameIssues).toEqual([])
  })
})

describe("planToRequests", () => {
  it("chunks at 100 items and maps refs to node ids", () => {
    const nodes = Array.from({ length: 205 }, (_, index) => scannedNode("1:" + index, "Text " + index, { name: "Label " + index, autoRename: false }))
    const { plan } = setup(nodes)
    const chunks = planToRequests(plan)
    expect(chunks.map((chunk) => chunk.items.length)).toEqual([100, 100, 5])
    expect(chunks[2].items[4]).toMatchObject({ client_ref: "c204", op: "create", text: "Text 204" })
    expect(chunks[2].nodeIdsByRef.get("c204")).toEqual(["1:204"])
    for (const chunk of chunks) {
      for (const item of chunk.items) {
        expect(item.client_ref.length).toBeLessThanOrEqual(128)
      }
    }
  })

  it("excludes unselected creates", () => {
    const { plan } = setup([scannedNode("1:1", "Pay now")], { scope: "page" })
    expect(planToRequests(plan)).toEqual([])
  })
})

describe("rule 10: after the response", () => {
  const nodes = [
    scannedNode("1:1", "Pay now"),
    scannedNode("1:2", "Pay now"),
    linked("2:1", "Pay securely", K1, "Pay now"),
    linked("I3:1;2:1", "Pay securely", K1, "Pay now", { nid: "2:1", state: "inherited" }),
    linked("I3:2;9:9", "Pay securely", K1, "Pay now", { nid: "9:9", state: "inherited" }),
    linked("I3:3;9:9", "Pay securely", K1, "Pay now", { nid: "9:9", state: "inherited" }),
  ]

  function respond(results: FigmaPushResult[]) {
    const { plan, context } = setup(nodes, { remote: [[K1, remoteState("checkout_title", "Pay now")]] })
    const [chunk] = planToRequests(plan)
    return pushFollowUp({ projectId: PROJECT_ID, chunk, results, nodes: context.nodes })
  }

  it("links every node of a created key and refreshes only ok nodes and local mains for updates", () => {
    const followUp = respond([
      { client_ref: "c0", status: "created", key_id: K2, key: "checkout_pay_now", reason: null, message: null, current_text: null },
      { client_ref: "u" + K1, status: "updated", key_id: K1, key: "checkout_title", reason: null, message: null, current_text: null },
    ])
    expect(followUp.linkApplies).toEqual([
      { nodeId: "1:1", keyId: K2, keyName: "checkout_pay_now", projectId: PROJECT_ID, src: src("Pay now") },
      { nodeId: "1:2", keyId: K2, keyName: "checkout_pay_now", projectId: PROJECT_ID, src: src("Pay now") },
      { nodeId: "2:1", keyId: K1, keyName: "checkout_title", projectId: PROJECT_ID, src: src("Pay securely") },
    ])
    expect(followUp.mainComponentLinkApplies).toEqual([{ nodeId: "I3:2;9:9", keyId: K1, keyName: "checkout_title", projectId: PROJECT_ID, src: src("Pay securely") }])
    expect(followUp.conflicts).toEqual([])
    expect(followUp.failures).toEqual([])
  })

  it("refreshes on unchanged results too", () => {
    const followUp = respond([{ client_ref: "u" + K1, status: "unchanged", key_id: K1, key: "checkout_title", reason: null, message: null, current_text: null }])
    expect(followUp.linkApplies.map((item) => item.nodeId)).toEqual(["2:1"])
  })

  it("reports conflicts with the current text", () => {
    const followUp = respond([
      { client_ref: "u" + K1, status: "conflict", key_id: K1, key: "checkout_title", reason: "source_changed", message: "changed", current_text: "Pay safely" },
    ])
    expect(followUp.conflicts).toEqual([
      { ref: "u" + K1, keyId: K1, keyName: "checkout_title", nodeIds: ["2:1", "I3:1;2:1", "I3:2;9:9", "I3:3;9:9"], text: "Pay securely", currentText: "Pay safely" },
    ])
  })

  it("reports failures, the existing key of a duplicate and quota exhaustion", () => {
    const followUp = respond([
      { client_ref: "c0", status: "failed", key_id: K3, key: "checkout_pay_now", reason: "duplicate_key", message: "exists", current_text: null },
      { client_ref: "u" + K1, status: "failed", key_id: K1, key: "checkout_title", reason: "quota_exceeded", message: "limit", current_text: null },
    ])
    expect(followUp.quotaExceeded).toBe(true)
    expect(followUp.failures).toEqual([
      { ref: "c0", reason: "duplicate_key", message: "A key with this name exists.", keyId: K3, keyName: "checkout_pay_now", nodeIds: ["1:1", "1:2"] },
      { ref: "u" + K1, reason: "quota_exceeded", message: "Your plan's key limit is reached.", keyId: K1, keyName: "checkout_title", nodeIds: ["2:1", "I3:1;2:1", "I3:2;9:9", "I3:3;9:9"] },
    ])
  })

  it("maps failure messages per Appendix B.2", () => {
    expect(failureMessage({ reason: "invalid_text", message: "translation key document is too large" })).toBe("translation key document is too large")
    expect(failureMessage({ reason: "max_length_exceeded", message: null }, 20)).toBe("Longer than the key's max length (20).")
    expect(failureMessage({ reason: "max_length_exceeded", message: null })).toBe("Longer than the key's max length.")
    expect(failureMessage({ reason: "key_disabled", message: "x" })).toBe("This key is disabled in ReRune.")
    expect(failureMessage({ reason: null, message: "boom" })).toBe("ReRune had a problem. Try again.")
  })
})

describe("writeTargets", () => {
  it("keeps direct nodes and one representative per inherited main", () => {
    const nodes = [
      linked("I1:1;5:67", "x", K1, "x", { nid: "5:67", state: "inherited" }),
      linked("5:67", "x", K1, "x"),
      linked("I1:2;6:1", "x", K1, "x", { nid: "6:1", state: "inherited" }),
      linked("I1:3;6:1", "x", K1, "x", { nid: "6:1", state: "inherited" }),
    ]
    expect(writeTargets(nodes)).toEqual(["5:67", "I1:2;6:1"])
  })
})

describe("plan shape", () => {
  it("starts empty for no nodes", () => {
    const { plan } = setup([])
    const empty: PushPlan = {
      creates: [],
      updates: [],
      divergent: [],
      conflicts: [],
      pulls: [],
      copied: [],
      missing: [],
      unchanged: 0,
      readonly: 0,
      otherProject: 0,
      invalid: 0,
      unknown: 0,
      blockedByPreview: [],
      maxLengthViolations: [],
    }
    expect(plan).toEqual(empty)
  })
})
