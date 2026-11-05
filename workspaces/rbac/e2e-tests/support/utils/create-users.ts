import { KeycloakHelper } from "@red-hat-developer-hub/e2e-test-utils/keycloak";
import {
  RBAC_DESCRIPTIVE_USERS,
  RBAC_GROUPS,
} from "../constants/users-and-groups";

export async function createUsersAndGroups(): Promise<void> {
  const keycloak = new KeycloakHelper();

  await keycloak.deploy();

  // Passwords are stable, and configureForRHDH leaves existing users in place.
  // Deleting them on a worker restart races the Keycloak catalog provider and
  // evicts the user entities mid-run.
  const realm = process.env.KEYCLOAK_REALM ?? "";

  await keycloak.configureForRHDH({
    realm: realm,
    groups: Object.values(RBAC_GROUPS).filter((g) => g.keycloak),
    users: Object.values(RBAC_DESCRIPTIVE_USERS),
  });
}
