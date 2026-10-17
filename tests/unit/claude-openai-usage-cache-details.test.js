import { describe, it, expect } from "vitest";
import { filterUsageForFormat } from "../../open-sse/utils/usageTracking.js";
import { translateNonStreamingResponse } from "../../open-sse/handlers/chatCore/nonStreamingHandler.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

// Claude upstream → OpenAI client: cache counters must survive into
// prompt_tokens_details, otherwise downstream billing sees every cache hit
// as fresh input.
describe("filterUsageForFormat (OpenAI client, Claude-shaped usage)", () => {
  it("maps cache_read/cache_creation into prompt_tokens_details", () => {
    const out = filterUsageForFormat({
      prompt_tokens: 20842, completion_tokens: 6, total_tokens: 20848,
      input_tokens: 11, output_tokens: 6,
      cache_read_input_tokens: 20831, cache_creation_input_tokens: 0,
    }, FORMATS.OPENAI);
    expect(out.prompt_tokens).toBe(20842);
    expect(out.prompt_tokens_details).toEqual({ cached_tokens: 20831 });
    expect(out.input_tokens).toBeUndefined();
    expect(out.cache_read_input_tokens).toBeUndefined();
  });

  it("includes cache_creation_tokens when the prompt was written to cache", () => {
    const out = filterUsageForFormat({
      prompt_tokens: 5000, completion_tokens: 1, cache_creation_input_tokens: 4990,
    }, FORMATS.OPENAI);
    expect(out.prompt_tokens_details).toEqual({ cache_creation_tokens: 4990 });
  });

  it("keeps an existing prompt_tokens_details untouched", () => {
    const details = { cached_tokens: 7 };
    const out = filterUsageForFormat({ prompt_tokens: 10, prompt_tokens_details: details, cache_read_input_tokens: 99 }, FORMATS.OPENAI);
    expect(out.prompt_tokens_details).toBe(details);
  });

  it("does not add details when there is no cache", () => {
    const out = filterUsageForFormat({ prompt_tokens: 10, completion_tokens: 2 }, FORMATS.OPENAI);
    expect(out.prompt_tokens_details).toBeUndefined();
  });

  it("leaves Claude-format usage as Claude fields", () => {
    const out = filterUsageForFormat({ input_tokens: 11, cache_read_input_tokens: 20831 }, FORMATS.CLAUDE);
    expect(out).toEqual({ input_tokens: 11, cache_read_input_tokens: 20831 });
  });
});

describe("translateNonStreamingResponse claude → openai usage", () => {
  it("folds cache into prompt_tokens and exposes prompt_tokens_details", () => {
    const res = translateNonStreamingResponse({
      id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5-5",
      content: [{ type: "text", text: "ok" }], stop_reason: "end_turn",
      usage: { input_tokens: 11, output_tokens: 6, cache_read_input_tokens: 20831, cache_creation_input_tokens: 120 },
    }, FORMATS.CLAUDE, FORMATS.OPENAI);
    expect(res.usage).toEqual({
      prompt_tokens: 20962, completion_tokens: 6, total_tokens: 20968,
      prompt_tokens_details: { cached_tokens: 20831, cache_creation_tokens: 120 },
    });
  });
});

describe("stream claude → openai usage", () => {
  it("final chunk keeps prompt_tokens_details.cached_tokens / cache_creation_tokens", async () => {
    const { createSSETransformStreamWithLogger } = await import("../../open-sse/utils/stream.js");
    const events = [
      { type: "message_start", message: { id: "msg_1", model: "claude-sonnet-5-5", role: "assistant", content: [],
        usage: { input_tokens: 11, output_tokens: 1, cache_read_input_tokens: 20831, cache_creation_input_tokens: 40 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 6 } },
      { type: "message_stop" },
    ];
    const encoder = new TextEncoder();
    const body = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
    const src = new ReadableStream({ start(c) { c.enqueue(encoder.encode(body)); c.close(); } });
    const out = src.pipeThrough(createSSETransformStreamWithLogger(FORMATS.CLAUDE, FORMATS.OPENAI, "claude", null, null, "claude-sonnet-5-5"));
    const reader = out.getReader();
    const decoder = new TextDecoder();
    let text = "";
    for (;;) { const { done, value } = await reader.read(); if (done) break; text += decoder.decode(value, { stream: true }); }
    const usages = text.split("\n").filter((l) => l.startsWith("data: {"))
      .map((l) => JSON.parse(l.slice(6)).usage).filter(Boolean);
    const usage = usages.at(-1);
    expect(usage.prompt_tokens_details).toEqual({ cached_tokens: 20831, cache_creation_tokens: 40 });
    expect(usage.completion_tokens).toBe(6);
    // prompt = 11 + 20831 + 40, plus the client-facing buffer
    expect(usage.prompt_tokens - 20882).toBeGreaterThanOrEqual(0);
  });
});
