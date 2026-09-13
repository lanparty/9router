import { describe, expect, it, vi } from "vitest";
import codex from "../../open-sse/handlers/imageProviders/codex.js";

const generation = vi.hoisted(() => ({
  handleImageGenerationBody: vi.fn(async (_request, body) =>
    new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } })
  ),
}));

vi.mock("../../src/sse/handlers/imageGeneration.js", () => generation);

import { handleImageEdit, parseImageEditRequest } from "../../src/sse/handlers/imageEdit.js";

function png(name, bytes = "png") {
  return new File([bytes], name, { type: "image/png" });
}

function jpeg(name, bytes = "jpeg") {
  return new File([bytes], name, { type: "image/jpeg" });
}

describe("OpenAI-compatible image edits", () => {
  it("normalizes one multipart image into a MIME-preserving data URL", async () => {
    const form = new FormData();
    form.set("model", "codex/gpt-5.5-image");
    form.set("prompt", "keep the product, replace the background");
    form.set("image", png("source.png", "source"));

    const body = await parseImageEditRequest(new Request("http://localhost/v1/images/edits", {
      method: "POST",
      body: form,
    }));

    expect(body.model).toBe("codex/gpt-5.5-image");
    expect(body.operation).toBe("edit");
    expect(body.images).toEqual([`data:image/png;base64,${Buffer.from("source").toString("base64")}`]);
  });

  it("preserves ten repeated image[] files in order", async () => {
    const form = new FormData();
    form.set("model", "codex/gpt-5.5-image");
    form.set("prompt", "use every product reference");
    for (let i = 0; i < 10; i += 1) {
      form.append("image[]", i % 2 === 0 ? png(`p${i}.png`, `p${i}`) : jpeg(`p${i}.jpg`, `p${i}`));
    }

    const body = await parseImageEditRequest(new Request("http://localhost/v1/images/edits", { method: "POST", body: form }));
    expect(body.images).toHaveLength(10);
    expect(body.images[0]).toMatch(/^data:image\/png;base64,/);
    expect(body.images[1]).toMatch(/^data:image\/jpeg;base64,/);

    const upstream = codex.buildBody("gpt-5.5-image", body);
    const content = upstream.input[0].content;
    expect(content.filter((part) => part.type === "input_image").map((part) => part.image_url)).toEqual(body.images);
  });

  it("accepts JSON image/images references", async () => {
    const request = new Request("http://localhost/v1/images/edits", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "codex/gpt-5.5-image",
        prompt: "edit",
        image: "data:image/png;base64,AAA",
        images: [
          { image_url: "data:image/jpeg;base64,BBB" },
          { image_url: { url: "https://example.com/c.png" } },
        ],
      }),
    });

    const body = await parseImageEditRequest(request);
    expect(body.images).toEqual([
      "data:image/jpeg;base64,BBB",
      "https://example.com/c.png",
      "data:image/png;base64,AAA",
    ]);
  });

  it("rejects multipart edits without a source image", async () => {
    const form = new FormData();
    form.set("model", "codex/gpt-5.5-image");
    form.set("prompt", "edit");
    await expect(parseImageEditRequest(new Request("http://localhost/v1/images/edits", { method: "POST", body: form })))
      .rejects.toThrow("Missing required field: image");
  });

  it("rejects unsupported MIME types, masks, file IDs, and filesystem paths", async () => {
    const bad = new FormData();
    bad.set("model", "codex/gpt-5.5-image");
    bad.set("prompt", "edit");
    bad.set("image", new File(["x"], "x.svg", { type: "image/svg+xml" }));
    await expect(parseImageEditRequest(new Request("http://localhost/v1/images/edits", { method: "POST", body: bad })))
      .rejects.toThrow("Unsupported image MIME type");

    const masked = new FormData();
    masked.set("model", "codex/gpt-5.5-image");
    masked.set("prompt", "edit");
    masked.set("image", png("source.png"));
    masked.set("mask", png("mask.png"));
    await expect(parseImageEditRequest(new Request("http://localhost/v1/images/edits", { method: "POST", body: masked })))
      .rejects.toThrow("mask is not supported");

    const fileId = new Request("http://localhost/v1/images/edits", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "codex/gpt-5.5-image", prompt: "edit", image: { file_id: "file-1" } }),
    });
    await expect(parseImageEditRequest(fileId)).rejects.toThrow("file_id is not supported");

    const path = new Request("http://localhost/v1/images/edits", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "codex/gpt-5.5-image", prompt: "edit", image: "/tmp/source.png" }),
    });
    await expect(parseImageEditRequest(path)).rejects.toThrow("Unsupported image reference");
  });

  it("delegates parsed edits into the existing image pipeline", async () => {
    generation.handleImageGenerationBody.mockClear();
    const form = new FormData();
    form.set("model", "codex/gpt-5.5-image");
    form.set("prompt", "edit");
    form.set("image", png("source.png"));
    const request = new Request("http://localhost/v1/images/edits", { method: "POST", body: form });

    const response = await handleImageEdit(request);
    expect(response.status).toBe(200);
    expect(generation.handleImageGenerationBody).toHaveBeenCalledTimes(1);
    expect(generation.handleImageGenerationBody.mock.calls[0][1].images).toHaveLength(1);
    expect(generation.handleImageGenerationBody.mock.calls[0][1].operation).toBe("edit");
  });
});
