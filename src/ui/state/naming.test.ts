import { describe, expect, it } from "vitest"
import { KEY_NAME_ISSUES, KEY_NAME_WARNINGS } from "../../shared/key-names"
import { checkNewKeyName, exampleKeyName, styleFor, suggesterFor, templateIssues } from "./naming"

describe("naming", () => {
  it("detects the project style unless the file settings pick one", () => {
    const sample = ["homeTitle", "homeSubtitle", "profileSaveButton"]
    expect(styleFor(null, sample)).toBe("camel")
    expect(styleFor({ caseStyle: "auto" }, sample)).toBe("camel")
    expect(styleFor({ caseStyle: "kebab" }, sample)).toBe("kebab")
    expect(styleFor(null, [])).toBe("snake")
  })

  it("suggests unique names against the sample and extra taken names", () => {
    const suggester = suggesterFor(["checkout_pay_button"], null, ["checkout_pay_button_2"])
    const source = { pageName: "Mobile", frameName: "Checkout", layerName: "Pay button", autoRename: false, text: "Pay now", componentName: null }
    expect(suggester.suggest(source)).toBe("checkout_pay_button_3")
    expect(suggester.suggest(source)).toBe("checkout_pay_button_4")
  })

  it("applies the template from the settings", () => {
    expect(exampleKeyName({ caseStyle: "auto", keyTemplate: "{page}.{frame}.{layer}" }, [])).toBe("mobile.checkout.pay_button")
    expect(exampleKeyName({ caseStyle: "camel", keyTemplate: null }, [])).toBe("checkoutPayButton")
  })

  it("validates typed names live", () => {
    expect(checkNewKeyName("checkout_pay", { taken: false, duplicate: false })).toEqual({ issues: [], warnings: [] })
    expect(checkNewKeyName("checkout pay", { taken: false, duplicate: false }).issues).toEqual([KEY_NAME_ISSUES.invalid])
    expect(checkNewKeyName("a", { taken: true, duplicate: true }).issues).toEqual([KEY_NAME_ISSUES.duplicate, KEY_NAME_ISSUES.taken])
    expect(checkNewKeyName("checkout.pay", { taken: false, duplicate: false }).warnings).toEqual([KEY_NAME_WARNINGS.dart, KEY_NAME_WARNINGS.androidDots])
    expect(checkNewKeyName("", { taken: false, duplicate: false })).toEqual({ issues: [KEY_NAME_ISSUES.invalid], warnings: [] })
  })

  it("flags unknown template placeholders", () => {
    expect(templateIssues("")).toEqual([])
    expect(templateIssues("{frame}_{layer}")).toEqual([])
    expect(templateIssues("{frame}_{name}")[0]).toContain("Unknown placeholder {name}")
    expect(templateIssues("fixed_text")).toEqual(["Add at least one placeholder, for example {frame}_{layer}."])
  })
})
