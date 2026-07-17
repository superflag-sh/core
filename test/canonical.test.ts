import { describe, expect, test } from "bun:test";
import { stableJsonSignature } from "../src/canonical.js";

describe("stable JSON signatures", () => {
  test("sorts object keys recursively", () => {
    const left = {
      z: { beta: 2, alpha: 1 },
      a: [{ y: true, x: false }],
    } as const;
    const right = {
      a: [{ x: false, y: true }],
      z: { alpha: 1, beta: 2 },
    } as const;

    expect(stableJsonSignature(left)).toBe(stableJsonSignature(right));
    expect(stableJsonSignature(left)).toBe(
      '{"a":[{"x":false,"y":true}],"z":{"alpha":1,"beta":2}}',
    );
  });

  test("preserves array order and JSON string escaping", () => {
    expect(stableJsonSignature(["a", "b"])).not.toBe(
      stableJsonSignature(["b", "a"]),
    );
    expect(stableJsonSignature({ 'quote"': "line\n" })).toBe(
      '{"quote\\\"":"line\\n"}',
    );
  });

  test("maps an omitted options object to the empty-object signature", () => {
    expect(stableJsonSignature(undefined)).toBe("{}");
    expect(stableJsonSignature({})).toBe("{}");
  });
});
