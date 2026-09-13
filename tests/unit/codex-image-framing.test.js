import { describe, expect, it } from "vitest";
import codex from "../../open-sse/handlers/imageProviders/codex.js";

function streamedResponse(chunks) {
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  }), { headers: { "Content-Type": "text/event-stream" } });
}

describe("Codex image SSE framing", () => {
  it("accepts a final event without a trailing blank separator", async () => {
    const body = "event: response.output_item.done\ndata: {\"item\":{\"type\":\"image_generation_call\",\"result\":\"ZmluYWw=\"}}";
    const result = await codex.parseResponse(new Response(body, { headers: { "Content-Type": "text/event-stream" } }), {});
    expect(result.data[0].b64_json).toBe("ZmluYWw=");
  });

  it("handles multiline data and split UTF-8 chunks", async () => {
    const body = "event: response.output_item.done\r\ndata: {\r\ndata: \"item\": {\r\ndata: \"type\": \"image_generation_call\",\r\ndata: \"result\": \"a\uD83D\uDE80b\"\r\ndata: }\r\ndata: }\r\n\r\n";
    const bytes = new TextEncoder().encode(body);
    const split = bytes.findIndex((value, index) => index > 0 && value === 0x80);
    const response = streamedResponse([bytes.slice(0, split), bytes.slice(split)]);
    const result = await codex.parseResponse(response, {});
    expect(result.data[0].b64_json).toBe("a🚀b");
  });

  it("fails when an image is followed by a terminal upstream failure", async () => {
    const body = [
      "event: response.output_item.done\ndata: {\"item\":{\"type\":\"image_generation_call\",\"result\":\"partial\"}}\n\n",
      "data: {\"type\":\"response.failed\",\"response\":{\"error\":{\"message\":\"late failure\"}}}\n\n",
    ].join("");
    await expect(codex.parseResponse(new Response(body), {})).rejects.toThrow("late failure");
  });
});
