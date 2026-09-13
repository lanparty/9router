import { describe, expect, it } from "vitest";
import codex from "../../open-sse/handlers/imageProviders/codex.js";

function response(event, data, trailingSeparator = true) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}`;
  return new Response(frame + (trailingSeparator ? "\n\n" : ""), {
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("Codex image stream errors", () => {
  const message = "This model requires a newer version of Codex.";

  it.each([
    ["error", { error: { message, code: "client_version" } }],
    ["response.failed", { response: { error: { message, code: "client_version" } } }],
    ["response.completed", { response: { status: "failed", error: { message, code: "client_version" } } }],
    ["response.incomplete", { response: { incomplete_details: { reason: message } } }],
  ])("preserves the upstream error in %s for binary/JSON clients", async (event, data) => {
    await expect(codex.parseResponse(response(event, data), {})).rejects.toMatchObject({ message, code: event === "response.incomplete" ? undefined : "client_version" });
  });

  it("preserves status and code for an upstream model failure", async () => {
    await expect(codex.parseResponse(response("error", {
      error: { message: "Model unavailable", code: "model_not_found", status_code: 404 },
    }), {})).rejects.toMatchObject({ message: "Model unavailable", code: "model_not_found", statusCode: 404 });
  });

  it("preserves upstream errors for streaming clients and never signals success", async () => {
    let successes = 0;
    const { sseResponse } = await codex.parseResponse(
      response("response.failed", { response: { error: { message, code: "client_version" } } }),
      { streamToClient: true, onRequestSuccess: () => { successes++; } },
    );
    const body = await sseResponse.text();
    expect(body).toContain(message);
    expect(body).toContain('"code":"client_version"');
    expect(body).not.toContain("event: done");
    expect(successes).toBe(0);
  });

  it("reports a text-only response without claiming entitlement failure", async () => {
    await expect(codex.parseResponse(response("response.output_item.done", {
      item: { type: "message", content: [{ type: "output_text", text: "Image generation is temporarily unavailable." }] },
    }), {})).rejects.toThrow("Codex completed without returning an image. Image generation is temporarily unavailable.");
  });
});
