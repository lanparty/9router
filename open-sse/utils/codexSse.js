const CODEX_IMAGE_ERROR_TEXT_LIMIT = 1000;

export function codexEventError(event, data) {
  const responseStatus = data?.response?.status || data?.status;
  const failed = event === "error"
    || event === "response.failed"
    || event === "response.incomplete"
    || responseStatus === "failed"
    || responseStatus === "incomplete";
  if (!failed) return null;

  const detail = data?.response?.error || data?.error;
  const message = detail?.message
    || (typeof detail === "string" ? detail : null)
    || data?.message
    || data?.response?.incomplete_details?.reason
    || "Codex response failed.";
  const error = new Error(String(message).slice(0, CODEX_IMAGE_ERROR_TEXT_LIMIT));
  error.code = typeof detail?.code === "string"
    ? detail.code
    : typeof data?.response?.code === "string" ? data.response.code : data?.code;
  for (const key of ["type", "param"]) {
    if (typeof detail?.[key] === "string") error[key] = detail[key];
  }
  const explicitStatus = Number(
    detail?.status_code
      ?? detail?.statusCode
      ?? data?.status_code
      ?? data?.statusCode
      ?? data?.response?.status_code
      ?? data?.response?.statusCode,
  );
  error.statusCode = Number.isInteger(explicitStatus) && explicitStatus >= 400 && explicitStatus <= 599
    ? explicitStatus
    : error.code === "model_not_found" ? 404
      : ["rate_limit_exceeded", "usage_limit_reached"].includes(error.code) ? 429
        : error.code === "invalid_api_key" ? 401
          : /requires a newer version of Codex/i.test(error.message) ? 400 : 502;
  return error;
}

// Incremental SSE framing shared by Codex image parsing and quota auto-ping.
// Handles CRLF, data-only events, multiline data, split UTF-8, and EOF frames.
export async function* readCodexEvents(response, signal) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Codex response did not include a readable body.");

  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;
  let bytesReceived = 0;
  const cancel = () => { reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });

  const parseBlocks = function* (final = false) {
    while (true) {
      const separator = /\r\n\r\n|\n\n|\r\r/.exec(buffer);
      if (!separator && !(final && buffer)) break;
      const block = separator ? buffer.slice(0, separator.index) : buffer;
      buffer = separator ? buffer.slice(separator.index + separator[0].length) : "";
      let event = null;
      const dataLines = [];
      for (const line of block.split(/\r\n|\n|\r/)) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
      }
      let data;
      if (dataLines.length) {
        try { data = JSON.parse(dataLines.join("\n")); } catch { /* Ignore keepalive/malformed frames. */ }
      }
      event ||= data?.type;
      if (event) yield { event, data, bytesReceived };
    }
  };

  try {
    while (!finished) {
      if (signal?.aborted) return;
      const chunk = await reader.read();
      finished = chunk.done;
      bytesReceived += chunk.value?.byteLength || 0;
      buffer += finished ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      yield* parseBlocks(finished);
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export const CODEX_IMAGE_NO_RESULT_ERROR = "Codex completed without returning an image.";
