import {
  APIHelper,
  CatalogApiHelper,
} from "@red-hat-developer-hub/e2e-test-utils/helpers";
import { KEYCLOAK_CATALOG_TOKEN } from "../constants/keycloak-auth";

type CatalogEntity = {
  spec?: { profile?: { displayName?: unknown } };
};

type CatalogQueryResponse = {
  items?: CatalogEntity[];
};

async function createCatalogApiHelper(baseUrl: string): Promise<APIHelper> {
  const apiHelper = new APIHelper();
  await apiHelper.setBaseUrl(baseUrl);
  await apiHelper.setStaticToken(KEYCLOAK_CATALOG_TOKEN);
  return apiHelper;
}

function profileDisplayName(entity: CatalogEntity): string | undefined {
  const name = entity.spec?.profile?.displayName;
  return typeof name === "string" ? name : undefined;
}

/** Bulk list + displayName match — APIHelper has no CatalogApiHelper equivalent. */
export async function checkUserDisplayNamesInCatalog(
  baseUrl: string,
  displayNames: string[],
): Promise<boolean> {
  try {
    const apiHelper = await createCatalogApiHelper(baseUrl);
    const body =
      (await apiHelper.getAllCatalogUsersFromAPI()) as CatalogQueryResponse;
    const found = (body.items ?? [])
      .map(profileDisplayName)
      .filter((name): name is string => typeof name === "string");
    return displayNames.every((name) => found.includes(name));
  } catch {
    return false;
  }
}

export async function checkGroupDisplayNamesInCatalog(
  baseUrl: string,
  displayNames: string[],
): Promise<boolean> {
  try {
    const apiHelper = await createCatalogApiHelper(baseUrl);
    const body =
      (await apiHelper.getAllCatalogGroupsFromAPI()) as CatalogQueryResponse;
    const found = (body.items ?? [])
      .map(profileDisplayName)
      .filter((name): name is string => typeof name === "string");
    return displayNames.every((name) => found.includes(name));
  } catch {
    return false;
  }
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
