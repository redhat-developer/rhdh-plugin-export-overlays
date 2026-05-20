/** Pre-seeded catalog-import fixture repos (not janus-qe PR targets). */
export const CATALOG_FIXTURE_REPOS = {
  janusTest2BulkImport: "janus-test-2-bulk-import-test",
  janusTest3BulkImport: "janus-test-3-bulk-import",
} as const;

export function catalogDefaultComponentPath(componentName: string): string {
  return `/catalog/default/component/${encodeURIComponent(componentName)}`;
}
