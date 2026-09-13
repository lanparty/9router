import { describe, expect, it } from "vitest";

import { resolveChatRouting } from "../../open-sse/handlers/chatCore.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { getModelTargetFormat } from "../../open-sse/config/providerModels.js";
import { PROVIDERS } from "../../open-sse/config/providers.js";
import { resolveTransport } from "../../open-sse/services/provider.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { translateRequest } from "../../open-sse/translator/index.js";

describe("OpenAI GPT-5.6 Responses routing", () => {
  it("routes the GPT-5.6 family to Responses and keeps GPT-5.4 on Chat Completions", () => {
    for (const model of ["gpt-5.6", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-preview"]) {
      const route = resolveChatRouting("openai", model, FORMATS.OPENAI);
      expect(route.targetFormat).toBe(FORMATS.OPENAI_RESPONSES);
      expect(route.useTransport?.baseUrl).toBe("https://api.openai.com/v1/responses");
    }

    const control = resolveChatRouting("openai", "gpt-5.4", FORMATS.OPENAI);
    expect(control.targetFormat).toBe(FORMATS.OPENAI);
    expect(control.useTransport?.baseUrl).toBe("https://api.openai.com/v1/chat/completions");
    expect(getModelTargetFormat("openai", "gpt-5.4")).toBeNull();
    expect(PROVIDERS.openai.transports.map((t) => t.format)).toEqual(["openai", "openai-responses"]);
  });

  it("uses the Responses endpoint in the default executor", () => {
    const route = resolveChatRouting("openai", "gpt-5.6-sol", FORMATS.OPENAI);
    const executor = new DefaultExecutor("openai");
    expect(executor.buildUrl("gpt-5.6-sol", true, 0, { runtimeTransport: route.useTransport }))
      .toBe("https://api.openai.com/v1/responses");
    expect(resolveTransport("openai", FORMATS.OPENAI)?.baseUrl)
      .toBe("https://api.openai.com/v1/chat/completions");
  });

  it("keeps other multi-transport providers source-format-first", () => {
    expect(resolveChatRouting("minimax-cn", "MiniMax-M3", FORMATS.OPENAI).targetFormat)
      .toBe(FORMATS.OPENAI);
    expect(resolveChatRouting("opencode-go", "deepseek-v4-pro", FORMATS.OPENAI).useTransport?.format)
      .toBe(FORMATS.OPENAI);
  });

  it("translates Chat Completions tools and follow-up tool results to Responses", () => {
    const first = translateRequest(
      FORMATS.OPENAI,
      FORMATS.OPENAI_RESPONSES,
      "gpt-5.6-sol",
      {
        messages: [{ role: "user", content: "Check weather in Manado." }],
        reasoning_effort: "high",
        tools: [{
          type: "function",
          function: {
            name: "weather",
            description: "Get weather.",
            parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
          },
        }],
      },
      true,
      null,
      "openai",
    );

    expect(first.input).toEqual([expect.objectContaining({
      type: "message",
      role: "user",
      content: [expect.objectContaining({ type: "input_text", text: "Check weather in Manado." })],
    })]);
    expect(first.tools).toEqual([expect.objectContaining({ type: "function", name: "weather" })]);

    const followUp = translateRequest(
      FORMATS.OPENAI,
      FORMATS.OPENAI_RESPONSES,
      "gpt-5.6-sol",
      {
        messages: [
          { role: "user", content: "Check weather in Manado." },
          {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "call_weather",
              type: "function",
              function: { name: "weather", arguments: '{"city":"Manado"}' },
            }],
          },
          { role: "tool", tool_call_id: "call_weather", content: "Rain, 28 C" },
        ],
      },
      true,
      null,
      "openai",
    );

    expect(followUp.input).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "function_call", call_id: "call_weather", name: "weather" }),
      expect.objectContaining({ type: "function_call_output", call_id: "call_weather", output: "Rain, 28 C" }),
    ]));
  });
});
