import { afterEach, describe, expect, it, vi } from "vitest";
import {
  upstreamErrorFromResult,
  rememberUpstreamError,
  forgetUpstreamError,
  pickUpstreamError,
  upstreamErrorResponse,
} from "../../src/sse/services/upstreamErrors.js";

const usage429 = JSON.stringify({ error: { type: "usage_limit_reached", message: "The usage limit has been reached", plan_type: "plus", resets_at: 1794170000 } });
const model400 = JSON.stringify({ error: { message: "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.", type: "invalid_request_error" } });

describe("upstream error replay (codex)", () => {
  afterEach(() => vi.useRealTimers());

  it("only captures codex results and never 401/403", () => {
    expect(upstreamErrorFromResult("claude", { status: 429, upstreamBody: usage429 })).toBeNull();
    expect(upstreamErrorFromResult("codex", { status: 401, upstreamBody: "{}" })).toBeNull();
    expect(upstreamErrorFromResult("codex", { status: 403, upstreamBody: "{}" })).toBeNull();
    expect(upstreamErrorFromResult("codex", { status: 429 })).toBeNull();
    expect(upstreamErrorFromResult("codex", { status: 429, upstreamBody: usage429, upstreamHeaders: { "x-codex-active-limit": "codex" } }))
      .toEqual({ status: 429, body: usage429, headers: { "x-codex-active-limit": "codex" } });
  });

  it("replays the error of the account that resets first", async () => {
    const now = Date.now();
    rememberUpstreamError("codex", "m1", "a", { status: 429, body: usage429, headers: {} }, now + 30 * 60_000);
    rememberUpstreamError("codex", "m1", "b", { status: 400, body: model400, headers: {} }, now + 5 * 60_000);
    expect(pickUpstreamError("codex", "m1").status).toBe(400);

    forgetUpstreamError("codex", "m1", "b");
    const res = upstreamErrorResponse(pickUpstreamError("codex", "m1"));
    expect(res.status).toBe(429);
    expect(await res.text()).toBe(usage429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(29 * 60);
  });

  it("ignores expired entries and other models", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    rememberUpstreamError("codex", "m2", "a", { status: 429, body: usage429, headers: {} }, 1_000_500);
    expect(pickUpstreamError("codex", "other")).toBeNull();
    vi.setSystemTime(1_001_000);
    expect(pickUpstreamError("codex", "m2")).toBeNull();
  });
});
