import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(async () => ({ shouldFallback: false, cooldownMs: 0 })),
  clearAccountError: vi.fn(async () => {}),
  extractApiKey: vi.fn(() => null),
  isValidApiKey: vi.fn(async () => true),
}));

vi.mock("../../src/sse/services/auth.js", () => auth);
vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn(async () => ({ requireApiKey: false })),
}));
vi.mock("../../src/sse/services/model.js", () => ({
  getComboModels: vi.fn(async () => null),
  getModelInfo: vi.fn(async (value) => {
    const [provider, ...model] = value.split("/");
    return { provider, model: model.join("/") };
  }),
}));
vi.mock("../../src/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: vi.fn(async (_provider, credentials) => credentials),
  updateProviderCredentials: vi.fn(async () => {}),
}));
vi.mock("open-sse/services/combo.js", () => ({ handleComboChat: vi.fn() }));
vi.mock("../../src/sse/utils/logger.js", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

import { handleImageEdit } from "../../src/sse/handlers/imageEdit.js";

const originalFetch = global.fetch;

function editRequest() {
  const form = new FormData();
  form.set("model", "openai/gpt-image-2.5");
  form.set("prompt", "Keep the product and replace the background");
  form.set("image", new File(["source"], "source.png", { type: "image/png" }));
  return new Request("http://localhost/v1/images/edits", { method: "POST", body: form });
}

describe("image edits pipeline composition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("rejects OpenAI edits before fetch when the connection uses the Images backend", async () => {
    auth.getProviderCredentials.mockResolvedValue({
      connectionId: "openai-images",
      apiKey: "test-key",
      providerSpecificData: { imageBackend: "images" },
    });

    const response = await handleImageEdit(editRequest());
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toContain("imageBackend=images");
    expect(body.error.message).toContain("imageBackend=responses");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("carries a multipart edit through the shared pipeline to OpenAI Responses", async () => {
    auth.getProviderCredentials.mockResolvedValue({
      connectionId: "openai-responses",
      apiKey: "test-key",
      providerSpecificData: { imageBackend: "responses" },
    });
    global.fetch.mockResolvedValue(new Response(JSON.stringify({
      created_at: 123,
      output: [{ type: "image_generation_call", result: "edited-image" }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    const response = await handleImageEdit(editRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual([{ b64_json: "edited-image" }]);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.openai.com/v1/responses",
      expect.objectContaining({ method: "POST" }),
    );
    const upstreamBody = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(upstreamBody.tools[0]).toMatchObject({ type: "image_generation", action: "edit" });
    expect(upstreamBody.input[0].content).toEqual([
      expect.objectContaining({ type: "input_image", image_url: expect.stringMatching(/^data:image\/png;base64,/) }),
      { type: "input_text", text: "Keep the product and replace the background" },
    ]);
  });
});
