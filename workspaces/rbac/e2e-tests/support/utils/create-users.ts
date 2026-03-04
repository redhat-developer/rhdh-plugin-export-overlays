import { KeycloakHelper } from "@red-hat-developer-hub/e2e-test-utils/keycloak";
import {
  RBAC_DESCRIPTIVE_USERS,
  RBAC_GROUPS,
} from "../constants/users-and-groups";

export async function createUsersAndGroups(): Promise<void> {
  const keycloak = new KeycloakHelper();

  await keycloak.deploy();

  // Check if users already exist due to a test failure/restart
  if (await keycloak.getUsers(process.env.KEYCLOAK_REALM!)) {
    // Randomly generated passwords will be recreated everytime the tests are restarted
    // We need to clean up the old users so that the new passwords can take affect
    for (const user of Object.values(RBAC_DESCRIPTIVE_USERS)) {
      await keycloak.deleteUser(process.env.KEYCLOAK_REALM!, user.username);
    }
  }

  await keycloak.configureForRHDH({
    groups: Object.values(RBAC_GROUPS).filter((g) => g.keycloak),
    users: Object.values(RBAC_DESCRIPTIVE_USERS),
  });
}
