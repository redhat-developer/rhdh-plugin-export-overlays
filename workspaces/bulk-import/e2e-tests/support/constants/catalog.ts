/** Pre-seeded catalog-import fixture org (not janus-qe PR targets). */
export const CATALOG_FIXTURE_ORG = "janus-test" as const;

/** Pre-seeded catalog-import fixture repos (not janus-qe PR targets). */
export const CATALOG_FIXTURE_REPOS = {
  janusTest2BulkImport: "janus-test-2-bulk-import-test",
} as const;

export function catalogImportComponentUrl(repoName: string): string {
  return `https://github.com/${CATALOG_FIXTURE_ORG}/${repoName}/blob/main/catalog-info.yaml`;
}

export function catalogDefaultComponentPath(componentName: string): string {
  return `/catalog/default/component/${encodeURIComponent(componentName)}`;
}
