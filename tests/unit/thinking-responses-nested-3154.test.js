import { describe, expect, it } from "vitest";

import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

describe("#3154 reasoning effort nesting for Responses targets", () => {
  it("nests effort under reasoning for Responses and keeps chat effort flat", () => {
    const responses = { reasoning_effort: "high" };
    applyThinking(FORMATS.OPENAI_RESPONSES, "gpt-5.6-luna", responses, "openai-compatible-responses-abc");
    expect(responses.reasoning_effort).toBeUndefined();
    expect(responses.reasoning).toEqual({ effort: "high" });

    const chat = { reasoning_effort: "high" };
    applyThinking(FORMATS.OPENAI, "gpt-5.6-luna", chat, "openai-compatible-chat-abc");
    expect(chat.reasoning_effort).toBe("high");
    expect(chat.reasoning).toBeUndefined();
  });

  it("preserves sibling reasoning keys and supports the singular Responses format", () => {
    const body = { reasoning: { effort: "low", mode: "pro", summary: "detailed" } };
    applyThinking(FORMATS.OPENAI_RESPONSE, "gpt-5.6-luna(high)", body, "openai-compatible-responses-abc");
    expect(body.reasoning).toEqual({ effort: "high", mode: "pro", summary: "detailed" });

    const disabled = { reasoning_effort: "none" };
    applyThinking(FORMATS.OPENAI_RESPONSES, "gpt-5.6-luna", disabled, "openai-compatible-responses-abc");
    expect(disabled.reasoning).toEqual({ effort: "none" });
  });

  it("keeps native Responses input nested and strips reasoning from non-reasoning models", () => {
    const native = translateRequest(
      FORMATS.OPENAI_RESPONSES,
      FORMATS.OPENAI_RESPONSES,
      "gpt-5.6-luna",
      { input: "hi", reasoning: { effort: "high", mode: "pro" } },
      true,
      {},
      "openai-compatible-responses-abc",
    );
    expect(native.reasoning_effort).toBeUndefined();
    expect(native.reasoning).toEqual({ effort: "high", mode: "pro" });

    const nonReasoning = { reasoning_effort: "high" };
    applyThinking(FORMATS.OPENAI_RESPONSES, "gpt-4o-mini", nonReasoning, "openai-compatible-responses-abc");
    expect(nonReasoning.reasoning_effort).toBeUndefined();
    expect(nonReasoning.reasoning).toBeUndefined();
  });

  it("removes the flat key from an end-to-end Chat to Responses translation", () => {
    const out = translateRequest(
      FORMATS.OPENAI,
      FORMATS.OPENAI_RESPONSES,
      "gpt-5.6-luna",
      { messages: [{ role: "user", content: "hi" }], reasoning_effort: "high" },
      true,
      {},
      "openai-compatible-responses-abc",
    );
    expect(out.reasoning_effort).toBeUndefined();
    expect(out.reasoning).toEqual({ effort: "high", summary: "auto" });
  });
});
