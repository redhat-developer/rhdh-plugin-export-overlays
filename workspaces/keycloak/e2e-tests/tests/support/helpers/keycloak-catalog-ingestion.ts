import { request } from "@playwright/test";
import { CatalogApiHelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";
import { KEYCLOAK_CATALOG_TOKEN } from "../constants/keycloak-auth";

async function catalogQuery(
  baseUrl: string,
  filter: string,
): Promise<unknown[]> {
  const context = await request.newContext({ ignoreHTTPSErrors: true });
  try {
    const url = `${baseUrl}/api/catalog/entities/by-query?orderField=metadata.name%2Casc&filter=${encodeURIComponent(filter)}`;
    const response = await context.get(url, {
      headers: { Authorization: `Bearer ${KEYCLOAK_CATALOG_TOKEN}` },
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

function profileDisplayName(entity: unknown): string | undefined {
  if (typeof entity !== "object" || entity === null) {
    return undefined;
  }
  const name = (entity as { spec?: { profile?: { displayName?: unknown } } })
    .spec?.profile?.displayName;
  return typeof name === "string" ? name : undefined;
}

export async function checkUserDisplayNamesInCatalog(
  baseUrl: string,
  displayNames: string[],
): Promise<boolean> {
  const found = (await catalogQuery(baseUrl, "kind=user"))
    .map(profileDisplayName)
    .filter((name): name is string => typeof name === "string");
  return displayNames.every((name) => found.includes(name));
}

export async function checkGroupDisplayNamesInCatalog(
  baseUrl: string,
  displayNames: string[],
): Promise<boolean> {
  const found = (await catalogQuery(baseUrl, "kind=group"))
    .map(profileDisplayName)
    .filter((name): name is string => typeof name === "string");
  return displayNames.every((name) => found.includes(name));
}

export async function checkGroupHasMembers(
  baseUrl: string,
  groupName: string,
  memberNames: string[],
): Promise<boolean> {
  try {
    const members = await CatalogApiHelper.getGroupMembers(
      baseUrl,
      KEYCLOAK_CATALOG_TOKEN,
      groupName,
    );
    return memberNames.every((name) => members.includes(name));
  } catch {
    return false;
  }
}

export async function catalogEntityExists(
  baseUrl: string,
  kind: "user" | "group",
  name: string,
): Promise<boolean> {
  return CatalogApiHelper.entityExists(
    baseUrl,
    KEYCLOAK_CATALOG_TOKEN,
    kind,
    name,
  );
}
