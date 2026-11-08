// Codex OAuth image generation: native Images API for GPT Image, Responses SSE for edits.
import { randomUUID } from "node:crypto";
import { nowSec } from "./_base.js";
import { PROVIDERS } from "../../config/providers.js";
import { PROVIDER_MEDIA } from "../../providers/index.js";
import { CODEX_CLI_VERSION } from "../../config/appConstants.js";
import {
  CODEX_IMAGE_NO_RESULT_ERROR,
  codexEventError,
  readCodexEvents,
} from "../../utils/codexSse.js";

const CODEX_RESPONSES_URL = PROVIDERS["codex"].baseUrl;
// Codex OAuth image generation uses the native Images endpoint. The Responses
// image_generation path has returned unsupported `complexity=medium` errors for
// GPT Image models. Native has ignored explicit n/size/format controls,
// so preserve Responses for those requests, edits, and older virtual models.
const CODEX_IMAGES_GENERATIONS_URL = PROVIDER_MEDIA.codex.imageConfig.baseUrl;
const CODEX_USER_AGENT = `codex_cli_rs/${CODEX_CLI_VERSION}`;
const CODEX_ORIGINATOR = "codex_cli_rs";
const CODEX_MODEL_SUFFIX = "-image";
const CODEX_REF_DETAIL = "high";
// Only drives the image_generation tool call; any chat model on the plan works as host.
const CODEX_IMAGES_MAIN_MODEL = "gpt-6-sol";
const CODEX_TOOL_IMAGE_MODELS = new Set([
  "gpt-image-1.5",
  "gpt-image-2",
  "gpt-image-2.5",
  "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst",
  "gpt-image-2.6-flare",
  "gpt-image-2.6-sunburst",
]);

function decodeOpenAIAuthClaims(token) {
  try {
    const parts = String(token || "").split(".");
    if (parts.length !== 3) return null;
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const pad = (4 - (b64.length % 4)) % 4;
    const payload = JSON.parse(Buffer.from(b64 + "=".repeat(pad), "base64").toString("utf8"));
    return payload?.["https://api.openai.com/auth"] || null;
  } catch {
    return null;
  }
}

function decodeAccountId(idToken) {
  return decodeOpenAIAuthClaims(idToken)?.chatgpt_account_id || null;
}

// Token claims first: the stored chatgptPlanType is only set at OAuth/import time and goes stale on plan changes.
function resolveChatgptPlanType(creds) {
  return decodeOpenAIAuthClaims(creds?.accessToken)?.chatgpt_plan_type
    || decodeOpenAIAuthClaims(creds?.idToken)?.chatgpt_plan_type
    || creds?.providerSpecificData?.chatgptPlanType
    || null;
}

function stripImageSuffix(model) {
  return model.endsWith(CODEX_MODEL_SUFFIX) ? model.slice(0, -CODEX_MODEL_SUFFIX.length) : model;
}

function resolveCodexImageModels(model) {
  if (CODEX_TOOL_IMAGE_MODELS.has(model)) {
    return { responsesModel: CODEX_IMAGES_MAIN_MODEL, toolModel: model };
  }
  return { responsesModel: stripImageSuffix(model), toolModel: null };
}

function hasImageRefs(body) {
  return Boolean(body?.image || (Array.isArray(body?.images) && body.images.length > 0));
}

function shouldUseNativeGeneration(model, body = {}) {
  // Native Codex has been observed returning one auto-sized PNG even when n,
  // size, or output_format requests something else. Do not silently reroute
  // those requests to a transport that cannot honor their output controls.
  return CODEX_TOOL_IMAGE_MODELS.has(model)
    && !hasImageRefs(body)
    && (body.n == null || body.n === 1)
    && (!body.size || body.size === "auto")
    && (!body.output_format || body.output_format.toLowerCase() === "png")
    && (!body.background || ["auto", "opaque"].includes(body.background))
    && (!body.quality || ["auto", "low", "medium", "high"].includes(body.quality))
    && body.output_compression == null;
}

function buildNativeGenerationBody(model, body) {
  return {
    model,
    prompt: body.prompt,
    n: 1,
    size: "auto",
    quality: body.quality || "auto",
    background: body.background || "auto",
    output_format: "png",
  };
}

function toDataUrl(input) {
  if (!input || typeof input !== "string") return null;
  if (/^data:image\//i.test(input) || /^https?:\/\//i.test(input)) return input;
  return `data:image/png;base64,${input}`;
}

function buildContent(prompt, refs, detail = CODEX_REF_DETAIL) {
  const content = [];
  refs.forEach((url, index) => {
    content.push({ type: "input_text", text: `<image name=image${index + 1}>` });
    content.push({ type: "input_image", image_url: url, detail });
    content.push({ type: "input_text", text: "</image>" });
  });
  content.push({ type: "input_text", text: prompt });
  return content;
}

function extractStreamError(data) {
  if (!data) return null;
  if (typeof data === "string") return data;
  if (data.error?.message) return data.error.message;
  if (data.response?.error?.message) return data.response.error.message;
  if (data.item?.error?.message) return data.item.error.message;
  if (data.response?.status_details?.error?.message) return data.response.status_details.error.message;
  if (typeof data.error === "string") return data.error;
  if (typeof data.message === "string") return data.message;
  return null;
}

function normalizeResponsesUsage(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const input = raw.input_tokens ?? raw.prompt_tokens;
  const output = raw.output_tokens ?? raw.completion_tokens;
  if (!Number.isSafeInteger(input) || input < 0 || !Number.isSafeInteger(output) || output < 0) return null;

  const usage = {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: Number.isSafeInteger(raw.total_tokens) ? raw.total_tokens : input + output,
  };
  const cached = raw.input_tokens_details?.cached_tokens ?? raw.prompt_tokens_details?.cached_tokens;
  const reasoning = raw.output_tokens_details?.reasoning_tokens ?? raw.completion_tokens_details?.reasoning_tokens;
  if (Number.isSafeInteger(cached) && cached >= 0) usage.cached_tokens = cached;
  if (Number.isSafeInteger(reasoning) && reasoning >= 0) usage.reasoning_tokens = reasoning;
  return usage;
}

function nativeImageSseResponse(result) {
  return new Response(`event: done\ndata: ${JSON.stringify(result)}\n\n`, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

// Parse Codex SSE stream → final base64 image. Optional callbacks for client streaming.
async function parseStream(response, log, callbacks = {}, signal) {
  let imageB64 = null;
  let upstreamError = null;
  let outputText = "";
  let lastEvent = null;
  let bytesReceived = 0;
  let lastProgressLogMs = 0;
  let usage = null;

  for await (const frame of readCodexEvents(response, signal)) {
    const error = codexEventError(frame.event, frame.data);
    if (error) throw error;
    const eventName = frame.event;
    const data = frame.data;
    bytesReceived = frame.bytesReceived;
    if (eventName !== lastEvent) {
      log?.info?.("IMAGE", `codex progress: ${eventName}`);
      lastEvent = eventName;
    }

    const now = Date.now();
    if (callbacks.onProgress && now - lastProgressLogMs > 200) {
      lastProgressLogMs = now;
      callbacks.onProgress({ stage: eventName, bytesReceived });
    }

    if (eventName === "response.image_generation_call.partial_image" && data?.partial_image_b64) {
      callbacks.onPartialImage?.({ b64_json: data.partial_image_b64, index: data.partial_image_index });
    }

    if (eventName === "response.output_text.delta" && typeof data?.delta === "string") {
      outputText = `${outputText}${data.delta}`.slice(0, 1000);
    }

    const items = eventName === "response.output_item.done" ? [data?.item]
      : eventName === "response.completed" ? (data?.response?.output || [])
        : [];
    for (const item of items) {
      if (item?.type === "image_generation_call") {
        if (item.result) imageB64 = item.result;
        else upstreamError = extractStreamError(item) || upstreamError;
      }
      if (item?.type === "message" && Array.isArray(item.content)) {
        const text = item.content
          .map((part) => (typeof part === "string" ? part : part?.refusal || part?.text || part?.output_text))
          .filter((t) => typeof t === "string")
          .join(" ")
          .trim();
        if (text) outputText = text.slice(0, 1000);
      }
    }

    if (eventName === "response.completed" || eventName === "response.done") {
      usage = normalizeResponsesUsage(data?.response?.usage ?? data?.usage) || usage;
    }
  }
  if (!imageB64 && !upstreamError && outputText.trim()) {
    upstreamError = `${CODEX_IMAGE_NO_RESULT_ERROR} ${outputText.trim()}`;
  }
  return { imageB64, usage, error: upstreamError };
}

// SSE Response that pipes codex progress + partial + done events to client
function buildSseResponse(providerResponse, log, onSuccess, onUsage) {
  const abort = new AbortController();
  let cancelled = false;
  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (event, data) => {
        controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      try {
        const { imageB64: b64, usage, error: upstreamError } = await parseStream(providerResponse, log, {
          onProgress: (info) => send("progress", info),
          onPartialImage: (info) => send("partial_image", info),
        }, abort.signal);
        if (cancelled) return;
        if (!b64) {
          send("error", { message: upstreamError || CODEX_IMAGE_NO_RESULT_ERROR, status: 502 });
        } else {
          if (usage && onUsage) await onUsage(usage);
          if (onSuccess) await onSuccess();
          send("done", { created: nowSec(), data: [{ b64_json: b64 }] });
        }
      } catch (err) {
        if (!cancelled) send("error", {
          message: err?.message || "Stream failed",
          ...(err?.code ? { code: err.code } : {}),
          ...(err?.type ? { type: err.type } : {}),
          ...(err?.param ? { param: err.param } : {}),
          status: err?.statusCode || 502,
        });
      } finally {
        if (!cancelled) controller.close();
      }
    },
    cancel() {
      cancelled = true;
      abort.abort();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

export default {
  stream: true,
  supportsEdit: true,
  // ChatGPT Free accounts have the image_generation tool stripped server-side
  // (upstream returns 400 "Tool choice 'image_generation' must be specified with 'tools' parameter").
  // Unknown plan is allowed so accounts without plan claims keep working.
  canUseCredentials: (creds) => resolveChatgptPlanType(creds) !== "free",
  buildUrl: (model, creds, body) => shouldUseNativeGeneration(model, body)
    ? CODEX_IMAGES_GENERATIONS_URL
    : CODEX_RESPONSES_URL,
  buildHeaders: (creds, requestBody) => {
    const accountId = creds?.providerSpecificData?.chatgptAccountId || decodeAccountId(creds?.idToken);
    return {
      "accept": requestBody?.prompt && !requestBody?.input
        ? "application/json"
        : "text/event-stream, application/json",
      "authorization": `Bearer ${creds?.accessToken || ""}`,
      "chatgpt-account-id": accountId || "",
      "content-type": "application/json",
      "originator": CODEX_ORIGINATOR,
      "session_id": randomUUID(),
      "user-agent": CODEX_USER_AGENT,
      "version": CODEX_CLI_VERSION,
      "x-client-request-id": randomUUID(),
    };
  },
  buildBody: (model, body) => {
    if (shouldUseNativeGeneration(model, body)) return buildNativeGenerationBody(model, body);

    const refs = [];
    if (Array.isArray(body.images)) body.images.forEach((i) => { const u = toDataUrl(i); if (u) refs.push(u); });
    const single = toDataUrl(body.image);
    if (single) refs.push(single);
    const detail = body.image_detail || CODEX_REF_DETAIL;
    const { responsesModel, toolModel } = resolveCodexImageModels(model);
    const imgTool = { type: "image_generation", output_format: (body.output_format || "png").toLowerCase() };
    if (toolModel) {
      imgTool.action = refs.length > 0 ? "edit" : "generate";
      imgTool.model = toolModel;
    }
    if (body.size && body.size !== "") imgTool.size = body.size;
    if (body.quality && body.quality !== "") imgTool.quality = body.quality;
    // The ChatGPT Codex backend currently rejects every explicit complexity level.
    // Omit it so GPT Image 2.6 uses its supported upstream default.
    if (body.background && body.background !== "") imgTool.background = body.background;
    return {
      model: responsesModel,
      instructions: "",
      input: [{ type: "message", role: "user", content: buildContent(body.prompt, refs, detail) }],
      tools: [imgTool],
      tool_choice: toolModel ? { type: "image_generation" } : "auto",
      parallel_tool_calls: false,
      prompt_cache_key: randomUUID(),
      stream: true,
      store: false,
      reasoning: null,
    };
  },
  // Custom: codex parses SSE → either pipe to client or collect b64
  async parseResponse(response, { log, streamToClient, onRequestSuccess, onUsage, requestBody }) {
    if (requestBody?.prompt && !requestBody?.input) {
      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new Error("Codex Images API returned invalid JSON.");
      }
      const data = Array.isArray(payload?.data) ? payload.data : [];
      if (!data.some((item) => item?.b64_json || item?.url)) {
        const error = payload?.error || {};
        const err = new Error(error.message || "Codex Images API returned no image.");
        for (const key of ["code", "type", "param"]) {
          if (typeof error[key] === "string") err[key] = error[key];
        }
        throw err;
      }
      const result = { created: payload.created || nowSec(), data };
      const usage = normalizeResponsesUsage(payload.usage);
      if (streamToClient) {
        if (usage && onUsage) await onUsage(usage);
        if (onRequestSuccess) await onRequestSuccess();
        return { sseResponse: nativeImageSseResponse(result) };
      }
      if (usage && onUsage) await onUsage(usage);
      return result;
    }

    if (streamToClient) {
      return { sseResponse: buildSseResponse(response, log, onRequestSuccess, onUsage) };
    }
    const { imageB64: b64, usage, error: upstreamError } = await parseStream(response, log);
    if (!b64) {
      throw new Error(upstreamError || CODEX_IMAGE_NO_RESULT_ERROR);
    }
    if (usage && onUsage) await onUsage(usage);
    return { created: nowSec(), data: [{ b64_json: b64 }] };
  },
  normalize: (responseBody) => responseBody,
};
