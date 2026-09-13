// OpenAI-compatible adapter (used by openai, minimax, openrouter, recraft)
import { PROVIDER_MEDIA } from "../../providers/index.js";
import { nowSec } from "./_base.js";

const IMAGES_BACKEND = "images";
const RESPONSES_BACKEND = "responses";

const imageCfg = (id) => PROVIDER_MEDIA[id]?.imageConfig || {};

function resolveBackend(providerId, credentials) {
  const cfg = imageCfg(providerId);
  if (providerId === "openai" && credentials?.providerSpecificData?.imageBackend === RESPONSES_BACKEND && cfg.responsesUrl) {
    return RESPONSES_BACKEND;
  }
  return cfg.defaultBackend || IMAGES_BACKEND;
}

function collectImageRefs(body) {
  const refs = [];
  const add = (value) => {
    if (typeof value === "string" && value) refs.push(value);
  };
  if (Array.isArray(body.images)) body.images.forEach(add);
  else add(body.images);
  if (Array.isArray(body.image)) body.image.forEach(add);
  else add(body.image);
  return refs;
}

function normalizeResponsesQuality(value) {
  if (!value) return undefined;
  const quality = String(value).toLowerCase();
  if (quality === "standard") return "medium";
  if (quality === "hd") return "high";
  if (["low", "medium", "high", "xhigh", "max", "auto"].includes(quality)) return quality;
  return undefined;
}

function buildResponsesBody(model, body, cfg) {
  const n = Number(body.n ?? 1);
  if (Number.isFinite(n) && n > 1) {
    throw new Error("OpenAI Responses image backend currently supports n=1");
  }

  const refs = collectImageRefs(body);
  const content = refs.map((image_url) => ({
    type: "input_image",
    image_url,
    ...(body.image_detail ? { detail: body.image_detail } : {}),
  }));
  content.push({ type: "input_text", text: body.prompt });

  const imageTool = {
    type: "image_generation",
    model: cfg.responsesImageModel || "gpt-image-2.5-sunburst",
    ...(refs.length > 0 ? { action: "edit" } : {}),
    ...(body.output_format ? { output_format: String(body.output_format).toLowerCase() } : {}),
    ...(body.size ? { size: body.size } : {}),
  };
  const quality = normalizeResponsesQuality(body.quality);
  if (quality) imageTool.quality = quality;
  if (body.background) imageTool.background = body.background;

  return {
    model,
    input: refs.length > 0 ? [{ role: "user", content }] : body.prompt,
    tools: [imageTool],
    tool_choice: { type: "image_generation" },
  };
}

function buildImagesBody(model, body, cfg) {
  const { prompt, n = 1, size = "1024x1024", quality, style, response_format } = body;
  const full = { model, prompt, n, size };
  if (quality) full.quality = quality;
  if (style) full.style = style;
  if (response_format) full.response_format = response_format;
  if (Array.isArray(cfg.bodyFields)) {
    const req = {};
    for (const f of cfg.bodyFields) if (full[f] !== undefined) req[f] = full[f];
    return req;
  }
  return full;
}

function normalizeResponsesBody(responseBody) {
  const images = [];
  let outputText = "";
  for (const item of responseBody?.output || []) {
    if (item?.type === "image_generation_call" && typeof item.result === "string" && item.result) {
      images.push({ b64_json: item.result });
    }
    if (item?.type === "message" && Array.isArray(item.content)) {
      for (const part of item.content) {
        const text = part?.refusal || part?.text;
        if (typeof text === "string" && text) outputText = `${outputText} ${text}`.trim();
      }
    }
  }

  if (images.length === 0) {
    const error = new Error(outputText
      ? `OpenAI Responses image generation returned no image: ${outputText.slice(0, 500)}`
      : "OpenAI Responses image generation returned no image");
    error.statusCode = 502;
    throw error;
  }

  return { created: responseBody?.created_at || nowSec(), data: images };
}

export default function createOpenAIAdapter(providerId) {
  const cfg = imageCfg(providerId);
  return {
    buildUrl: (_model, credentials) => resolveBackend(providerId, credentials) === RESPONSES_BACKEND
      ? cfg.responsesUrl : cfg.baseUrl,
    buildHeaders: (creds) => {
      const headers = { "Content-Type": "application/json", ...(cfg.headers || {}) };
      const key = creds?.apiKey || creds?.accessToken;
      if (key) headers["Authorization"] = `Bearer ${key}`;
      return headers;
    },
    buildBody: (model, body, credentials) => resolveBackend(providerId, credentials) === RESPONSES_BACKEND
      ? buildResponsesBody(model, body, cfg)
      : buildImagesBody(model, body, cfg),
    async parseResponse(response) {
      const responseBody = await response.json();
      if (providerId === "openai" && Array.isArray(responseBody?.output)) {
        return normalizeResponsesBody(responseBody);
      }
      return responseBody;
    },
    normalize: (responseBody) => responseBody,
  };
}
