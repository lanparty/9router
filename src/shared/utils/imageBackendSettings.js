function backendOptions(providerConfig) {
  return Array.isArray(providerConfig?.imageConfig?.backendOptions)
    ? providerConfig.imageConfig.backendOptions
    : [];
}

export function resolveImageBackend(providerConfig, providerSpecificData = {}) {
  const allowed = new Set(backendOptions(providerConfig).map((option) => option.value));
  const saved = providerSpecificData?.imageBackend;
  if (allowed.has(saved)) return saved;

  const configuredDefault = providerConfig?.imageConfig?.defaultBackend;
  return allowed.has(configuredDefault) ? configuredDefault : "images";
}

export function mergeImageBackendProviderSpecificData(
  providerSpecificData,
  providerConfig,
  selectedBackend,
) {
  const data = { ...(providerSpecificData || {}) };
  if (backendOptions(providerConfig).length === 0) return data;
  data.imageBackend = resolveImageBackend(providerConfig, { imageBackend: selectedBackend });
  return data;
}
