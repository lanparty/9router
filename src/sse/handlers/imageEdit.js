import { handleImageGenerationBody } from "./imageGeneration.js";
import { errorResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";

const SUPPORTED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 200 * 1024 * 1024;

function isUpload(value) {
  return value && typeof value === "object" && typeof value.arrayBuffer === "function";
}

function normalizeJsonImage(value) {
  if (typeof value === "string") return validateJsonImageReference(value);
  if (!value || typeof value !== "object") return null;
  if (typeof value.file_id === "string") throw new Error("file_id is not supported for image edits");
  if (typeof value.image_url === "string") return normalizeJsonImage(value.image_url);
  if (value.image_url && typeof value.image_url.url === "string") return normalizeJsonImage(value.image_url.url);
  if (typeof value.url === "string") return normalizeJsonImage(value.url);
  return null;
}

function validateJsonImageReference(value) {
  if (/^data:image\//i.test(value) || /^https?:\/\//i.test(value)) return value;
  throw new Error("Unsupported image reference; use an image data URL or HTTP(S) URL");
}

function collectJsonImages(body) {
  const images = [];
  const add = (value) => {
    const normalized = normalizeJsonImage(value);
    if (normalized) images.push(normalized);
  };
  if (Array.isArray(body.images)) body.images.forEach(add);
  else if (body.images != null) add(body.images);
  if (Array.isArray(body.image)) body.image.forEach(add);
  else if (body.image != null) add(body.image);
  return images;
}

async function uploadToDataUrl(file) {
  const mime = String(file.type || "").toLowerCase();
  if (!SUPPORTED_IMAGE_TYPES.has(mime)) {
    throw new Error(`Unsupported image MIME type: ${mime || "unknown"}`);
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error(`Image exceeds ${MAX_IMAGE_BYTES / 1024 / 1024} MB limit`);
  }
  const bytes = Buffer.from(await file.arrayBuffer());
  return { dataUrl: `data:${mime};base64,${bytes.toString("base64")}`, size: bytes.length };
}

async function parseMultipart(request) {
  let form;
  try {
    form = await request.formData();
  } catch {
    throw new Error("Invalid multipart form body");
  }

  if (form.get("mask") != null || form.get("mask_image") != null || form.get("maskImage") != null) {
    throw new Error("mask is not supported for image edits");
  }

  const body = {};
  const uploads = [];
  for (const [key, value] of form.entries()) {
    if (key === "image" || key === "image[]") {
      if (!isUpload(value)) throw new Error("Invalid image upload");
      uploads.push(value);
      continue;
    }
    if (typeof value === "string" && body[key] == null) body[key] = value;
  }

  if (uploads.length === 0) throw new Error("Missing required field: image");

  const images = [];
  let totalBytes = 0;
  for (const upload of uploads) {
    const { dataUrl, size } = await uploadToDataUrl(upload);
    totalBytes += size;
    if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
      throw new Error(`Total image input exceeds ${MAX_TOTAL_IMAGE_BYTES / 1024 / 1024} MB limit`);
    }
    images.push(dataUrl);
  }
  body.images = images;
  return body;
}

async function parseJson(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    throw new Error("Invalid JSON body");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid JSON body");
  if (body.file_id != null) throw new Error("file_id is not supported for image edits");
  if (body.mask != null || body.mask_image != null || body.maskImage != null) {
    throw new Error("mask is not supported for image edits");
  }
  const images = collectJsonImages(body);
  if (images.length === 0) throw new Error("Missing required field: image");
  return { ...body, images, image: undefined };
}

export async function parseImageEditRequest(request) {
  const contentType = (request.headers.get("content-type") || "").toLowerCase();
  if (contentType.includes("multipart/form-data")) return parseMultipart(request);
  if (contentType.includes("application/json")) return parseJson(request);
  throw new Error("Unsupported Content-Type for image edits");
}

export async function handleImageEdit(request) {
  let body;
  try {
    body = await parseImageEditRequest(request);
  } catch (error) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, error.message || "Invalid image edit request");
  }

  if (!body.prompt) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: prompt");
  if (!body.model) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  return handleImageGenerationBody(request, body);
}
