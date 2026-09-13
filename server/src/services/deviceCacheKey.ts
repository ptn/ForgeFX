// Device-cache doc key shared by the registry (runtime profile swap) and the device-cache services
// (deviceCache / editorCacheImport / cloudProfiles) so they all address the exact same doc.
// Format: `<model-hex>_<major>p<minor>` (e.g. FM3 fw 12.0 → `11_12p0`).

export function deviceCacheKey(modelId: number, major: number, minor: number): string {
  return `${modelId.toString(16).padStart(2, '0')}_${major}p${minor}`;
}
