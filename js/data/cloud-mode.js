// The Sites build adds this marker; the GitHub Pages copy stays browser-local.
export function usesCloudMarket() {
  return globalThis.document?.documentElement?.dataset?.cloudMode === "sites";
}
