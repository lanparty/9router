// handleChat: when every codex account is locked, replay the raw upstream error
// (status + body) of the account that frees up first instead of a generic 503.
import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({ locked: new Map(), results: [] }));

vi.mock("@/lib/localDb", () => ({
  getSettings: async () => ({ requireApiKey: false }),
  getModelAliases: async () => ({}),
  getComboByName: async () => null,
  getProviderNodes: async () => [],
  getCombos: async () => [],
  getProviderConnections: async () => [],
  getProviderConnectionById: async () => null,
  getCustomModels: async () => [],
}));
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: async () => ({}) }));
vi.mock("@/lib/usageDb.js", () => ({ saveRequestUsage: vi.fn() }));
vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: async (_provider, exclude) => {
    const free = ["a", "b"].find((id) => !exclude.has(id) && !(state.locked.get(id) > Date.now()));
    if (free) return { connectionId: free, connectionName: free, accessToken: "t" };
    return { allRateLimited: true, retryAfter: new Date(Date.now() + 60_000).toISOString(), retryAfterHuman: "reset after 1m", lastError: "x" };
  },
  markAccountUnavailable: async (id, status, _e, _p, _m, resetsAtMs) => {
    const cooldownMs = resetsAtMs ? resetsAtMs - Date.now() : 5 * 60_000;
    state.locked.set(id, Date.now() + cooldownMs);
    return { shouldFallback: true, cooldownMs };
  },
  clearAccountError: vi.fn(),
  extractApiKey: () => null,
  isValidApiKey: async () => true,
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: async (_p, c) => c,
  updateProviderCredentials: vi.fn(),
}));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: vi.fn(async () => state.results.shift()) }));

const { handleChat } = await import("../../src/sse/handlers/chat.js");

const fail = (status, body, resetsAtMs, headers = {}) => ({
  success: false, status, error: `[${status}]: x`, resetsAtMs,
  response: Response.json({ error: { message: "wrapped" } }, { status }),
  upstreamBody: JSON.stringify(body), upstreamHeaders: headers,
});
const req = (model) => new Request("http://localhost/v1/responses", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ model, input: "hi", stream: true }),
});

describe("handleChat codex upstream error replay", () => {
  beforeEach(() => { state.locked.clear(); state.results = []; });

  it("loops every account, then replays the error that resets first", async () => {
    const usage = { error: { type: "usage_limit_reached", message: "The usage limit has been reached", resets_at: 1794170000 } };
    const badModel = { error: { type: "invalid_request_error", message: "model not supported" } };
    state.results = [
      fail(429, usage, Date.now() + 25 * 60_000, { "x-codex-active-limit": "codex" }),
      fail(400, badModel, Date.now() + 2 * 60_000),
    ];
    const res = await handleChat(req("cx/gpt-6.1-sol"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(badModel);

    // Later request while both are locked: same pick, no upstream call.
    const again = await handleChat(req("cx/gpt-6.1-sol"));
    expect(again.status).toBe(400);
    expect(state.results).toHaveLength(0);
  });

  it("replays a single-account 429 verbatim with retry-after and codex headers", async () => {
    const usage = { error: { type: "usage_limit_reached", message: "limit", resets_at: 1794170000 } };
    state.locked.set("b", Date.now() + 60 * 60_000);
    state.results = [fail(429, usage, Date.now() + 10 * 60_000, { "x-codex-active-limit": "codex" })];
    const res = await handleChat(req("cx/gpt-6-luna"));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual(usage);
    expect(res.headers.get("x-codex-active-limit")).toBe("codex");
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(9 * 60);
  });
});
