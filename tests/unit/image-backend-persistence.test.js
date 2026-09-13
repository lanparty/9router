import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;

describe("OpenAI image backend persistence", () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-image-backend-"));
    process.env.DATA_DIR = tempDir;
    vi.resetModules();
    vi.doMock("next/server", () => ({
      NextResponse: {
        json(body, init = {}) {
          return new Response(JSON.stringify(body), {
            status: init.status || 200,
            headers: { "Content-Type": "application/json" },
          });
        },
      },
    }));
  });

  afterEach(() => {
    vi.doUnmock("next/server");
    vi.resetModules();
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it("stores a selected backend and preserves unrelated fields on update", async () => {
    const [{ POST }, { PUT }, models] = await Promise.all([
      import("../../src/app/api/providers/route.js"),
      import("../../src/app/api/providers/[id]/route.js"),
      import("../../src/models/index.js"),
    ]);

    const createResponse = await POST(new Request("http://localhost/api/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "openai",
        name: "OpenAI Images",
        apiKey: "test-key",
        providerSpecificData: { imageBackend: "responses", customFlag: true },
      }),
    }));
    const created = (await createResponse.json()).connection;
    const stored = await models.getProviderConnectionById(created.id);

    expect(createResponse.status).toBe(201);
    expect(stored.providerSpecificData).toMatchObject({
      imageBackend: "responses",
      customFlag: true,
    });

    const updateResponse = await PUT(new Request(`http://localhost/api/providers/${created.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerSpecificData: { imageBackend: "images" } }),
    }), { params: Promise.resolve({ id: created.id }) });
    const updated = (await updateResponse.json()).connection;

    expect(updateResponse.status).toBe(200);
    expect(updated.providerSpecificData).toMatchObject({
      imageBackend: "images",
      customFlag: true,
    });
  });
});
