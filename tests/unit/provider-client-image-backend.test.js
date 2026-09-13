import { describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: { json: vi.fn() },
}));
vi.mock("@/lib/localDb", () => ({ getProviderConnections: vi.fn() }));
vi.mock("@/lib/oauth/providers", () => ({ backfillCodexEmails: vi.fn() }));

import { sanitizeProviderConnection } from "../../src/app/api/providers/client/route.js";

describe("provider client image backend sanitizer", () => {
  it("exposes imageBackend while omitting secrets and unknown provider data", () => {
    const safe = sanitizeProviderConnection({
      id: "openai-1",
      provider: "openai",
      apiKey: "secret",
      providerSpecificData: {
        imageBackend: "responses",
        region: "us-east-1",
        refreshToken: "secret-refresh",
        unknownField: "private",
      },
    });

    expect(safe).toEqual({
      id: "openai-1",
      provider: "openai",
      providerSpecificData: {
        imageBackend: "responses",
        region: "us-east-1",
      },
    });
  });
});
