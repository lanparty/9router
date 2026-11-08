// Codex clients (openai/codex api_bridge.rs) branch on the raw upstream status + error body:
// 429 usage_limit_reached/usage_not_included/insufficient_quota, 400 policy codes, 503 overload.
// Keep the last raw error per locked account so "all accounts locked" can replay it verbatim.
// 401/403 stay hidden: the client would treat them as its own (9router) credentials failing.
// shortcut: in-memory only, a restart falls back to the generic 503 until accounts are retried.

const PASSTHROUGH_PROVIDERS = new Set(["codex"]);
const HIDDEN_STATUSES = new Set([401, 403]);
const errors = new Map(); // `${provider}|${model}` -> Map(connectionId -> entry)

export function upstreamErrorFromResult(provider, result) {
  if (!PASSTHROUGH_PROVIDERS.has(provider) || typeof result?.upstreamBody !== "string") return null;
  if (HIDDEN_STATUSES.has(result.status)) return null;
  return { status: result.status, body: result.upstreamBody, headers: result.upstreamHeaders || {} };
}

export function rememberUpstreamError(provider, model, connectionId, upstream, resetAtMs) {
  const key = `${provider}|${model}`;
  const byConn = errors.get(key) || new Map();
  const now = Date.now();
  for (const [id, entry] of byConn) if (entry.resetAtMs <= now) byConn.delete(id);
  byConn.set(connectionId, { ...upstream, resetAtMs });
  errors.set(key, byConn);
}

export function forgetUpstreamError(provider, model, connectionId) {
  errors.get(`${provider}|${model}`)?.delete(connectionId);
}

// Accounts can fail differently (429 on one, 400 on another): answer with the one that frees up first.
export function pickUpstreamError(provider, model) {
  const now = Date.now();
  let best = null;
  for (const entry of errors.get(`${provider}|${model}`)?.values() || []) {
    if (entry.resetAtMs > now && (!best || entry.resetAtMs < best.resetAtMs)) best = entry;
  }
  return best;
}

export function upstreamErrorResponse(upstream) {
  const headers = { ...upstream.headers, "Content-Type": "application/json" };
  if (upstream.resetAtMs) headers["retry-after"] = String(Math.max(Math.ceil((upstream.resetAtMs - Date.now()) / 1000), 1));
  return new Response(upstream.body, { status: upstream.status, headers });
}
