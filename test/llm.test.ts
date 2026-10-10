import { describe, expect, it } from "vitest";
import { GeminiProvider, ScriptedLlmProvider } from "../src/llm";

const risky = "Table orders. Change: add-index. Estimated lock 90s.";

describe("ScriptedLlmProvider reads message content via textOf (R5, ADR 0120)", () => {
  it("rates a string message and a parts message identically", async () => {
    const llm = new ScriptedLlmProvider();
    const asString = await llm.complete({ messages: [{ role: "user", content: risky }] });
    const asParts = await llm.complete({
      messages: [{ role: "user", content: [{ type: "text", text: risky }] }],
    });
    expect(JSON.parse(asString.content).risk).toBe("high");
    expect(JSON.parse(asParts.content)).toEqual(JSON.parse(asString.content));
  });
});

describe("GeminiProvider is text-only", () => {
  it("refuses media before any network call", async () => {
    await expect(
      new GeminiProvider("gemini-2.5-flash", "k").complete({
        messages: [
          {
            role: "user",
            content: [
              { type: "image", mediaType: "image/png", source: { kind: "data", data: "AAAA" } },
            ],
          },
        ],
      }),
    ).rejects.toThrow(/does not accept image/);
  });
});
