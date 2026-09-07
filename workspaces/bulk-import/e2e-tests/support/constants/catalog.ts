/**
 * The catalog-import page, reached directly rather than through the app shell.
 * The legacy RHDH shell exposes it behind the global header's "Self-service" button;
 * app-next ships no global header, so that path does not exist there. The route is the
 * same in both, and this test's subject is what happens after the import, not how the
 * page was reached.
 */
export const CATALOG_IMPORT_ROUTE = "/catalog-import" as const;

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
