import { request } from "@playwright/test";
import { CatalogApiHelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";

export async function catalogQuery(
  baseUrl: string,
  token: string,
  filter: string,
): Promise<unknown[]> {
  const context = await request.newContext({ ignoreHTTPSErrors: true });
  try {
    const url = `${baseUrl}/api/catalog/entities/by-query?orderField=metadata.name%2Casc&filter=${encodeURIComponent(filter)}`;
    const response = await context.get(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok()) {
      return [];
    }
    const body = (await response.json()) as { items?: unknown[] };
    return body.items ?? [];
  } finally {
    await context.dispose();
  }
}

export function profileDisplayName(entity: unknown): string | undefined {
  if (typeof entity !== "object" || entity === null) {
    return undefined;
  }
  const spec = (entity as { spec?: { profile?: { displayName?: unknown } } })
    .spec;
  const name = spec?.profile?.displayName;
  return typeof name === "string" ? name : undefined;
}

export async function checkUserDisplayNamesInCatalog(
  baseUrl: string,
  token: string,
  displayNames: string[],
): Promise<boolean> {
  const users = await catalogQuery(baseUrl, token, "kind=user");
  const found = users
    .map(profileDisplayName)
    .filter((name): name is string => typeof name === "string");
  return displayNames.every((name) => found.includes(name));
}

export async function checkGroupDisplayNamesInCatalog(
  baseUrl: string,
  token: string,
  displayNames: string[],
): Promise<boolean> {
  const groups = await catalogQuery(baseUrl, token, "kind=group");
  const found = groups
    .map(profileDisplayName)
    .filter((name): name is string => typeof name === "string");
  return displayNames.every((name) => found.includes(name));
}

export async function groupHasRelation(
  baseUrl: string,
  token: string,
  groupName: string,
  relationType: string,
  relatedName: string,
): Promise<boolean> {
  const entity = await CatalogApiHelper.getGroupEntity(
    baseUrl,
    token,
    groupName,
  );
  const names =
    entity.relations
      ?.filter((r: { type: string }) => r.type === relationType)
      .map((r: { targetRef: string }) => r.targetRef.split("/")[1]) ?? [];
  return names.includes(relatedName);
}
