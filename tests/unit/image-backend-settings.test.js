import { describe, expect, it } from "vitest";
import { AI_PROVIDERS } from "../../src/shared/constants/providers.js";
import {
  mergeImageBackendProviderSpecificData,
  resolveImageBackend,
} from "../../src/shared/utils/imageBackendSettings.js";

const openai = AI_PROVIDERS.openai;

describe("OpenAI image backend connection settings", () => {
  it("defaults missing and invalid selections to the Images backend", () => {
    expect(resolveImageBackend(openai)).toBe("images");
    expect(resolveImageBackend(openai, { imageBackend: "invalid" })).toBe("images");
  });

  it("persists an operator-selected Responses backend", () => {
    expect(mergeImageBackendProviderSpecificData({}, openai, "responses")).toEqual({
      imageBackend: "responses",
    });
  });

  it("preserves unrelated provider-specific fields while editing the backend", () => {
    expect(mergeImageBackendProviderSpecificData(
      { region: "us-east-1", customFlag: true, imageBackend: "images" },
      openai,
      "responses",
    )).toEqual({
      region: "us-east-1",
      customFlag: true,
      imageBackend: "responses",
    });
  });
});
