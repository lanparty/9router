const FORWARDED = new Set(["retry-after", "x-should-retry"]);
const FORWARDED_PREFIX = "anthropic-ratelimit-";

export function upstreamResponseHeaders(headers) {
  const out = {};
  if (typeof headers?.forEach !== "function") return out;
  headers.forEach((value, name) => {
    const key = name.toLowerCase();
    if (FORWARDED.has(key) || key.startsWith(FORWARDED_PREFIX)) out[key] = value;
  });
  return out;
}

// Codex CLI reads its quota snapshot (x-codex-*) and request ids from error responses.
export function codexErrorHeaders(headers) {
  const out = upstreamResponseHeaders(headers);
  headers?.forEach?.((value, name) => {
    const key = name.toLowerCase();
    if (key.startsWith("x-codex-") || key === "x-request-id" || key === "x-oai-request-id") out[key] = value;
  });
  return out;
}
