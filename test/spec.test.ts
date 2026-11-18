import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";

import { inlineRefs, loadRawSpec, loadSpec } from "../src/spec.js";
import { makeRedactor } from "../src/untrusted.js";

describe("spec/tools.json", () => {
  const spec = loadSpec();

  it("compiles every input and output schema", () => {
    const ajv = new Ajv({ strict: false });
    for (const t of spec.tools) {
      expect(() => ajv.compile(t.inputSchema), t.name).not.toThrow();
      expect(() => ajv.compile(t.outputSchema), t.name).not.toThrow();
    }
  });

  it("leaves no $ref in a tool schema", () => {
    expect(JSON.stringify(spec.tools)).not.toContain("$ref");
  });

  it("rejects an unknown $ref instead of passing it through", () => {
    expect(() => inlineRefs({ $ref: "#/$defs/Nope" }, loadRawSpec().$defs)).toThrow(/unknown \$ref/);
  });

  it("marks every v0 tool read-only and never takes a store id", () => {
    for (const t of spec.tools) {
      expect(t.scope, t.name).toBe("read");
      expect(t.annotations.readOnlyHint, t.name).toBe(true);
      expect(JSON.stringify(t.inputSchema), t.name).not.toContain("store_id");
    }
  });
});

describe("redaction rules", () => {
  const redact = makeRedactor(loadSpec().redaction.rules);

  it.each([
    ["0812-3456-7890", "[phone]"],
    ["081234567890", "[phone]"],
    ["+62 812 3456 7890", "[phone]"],
    ["6281234567890", "[phone]"],
    ["hubungi 0857.1234.5678 ya", "hubungi [phone] ya"],
    ["budi.santoso@example.com", "[email]"],
  ])("redacts %s", (input, want) => {
    expect(redact(input)).toBe(want);
  });

  it.each(["Rp 4.015.000", "Rp4015000", "total 4.438.500", "check-in 2026-11-10", "kamar 0805", "ID 1234567890"])(
    "keeps %s",
    (input) => {
      expect(redact(input)).toBe(input);
    },
  );
});
