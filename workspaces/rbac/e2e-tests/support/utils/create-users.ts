import { KeycloakHelper } from "@red-hat-developer-hub/e2e-test-utils/keycloak";
import {
  RBAC_DESCRIPTIVE_USERS,
  RBAC_GROUPS,
} from "../constants/users-and-groups";

export async function createUsersAndGroups(
  newRealm: string = "rhdh",
): Promise<void> {
  const keycloak = new KeycloakHelper();

  const isRunnig = await keycloak.isRunning();
  if (!isRunnig) {
    await keycloak.deploy();
  } else {
    await keycloak.connect({
      baseUrl: keycloak.keycloakUrl,
      realm: keycloak.realm,
      username: "admin",
      password: "admin123",
    });
  }

  // Check if users already exist due to a test failure/restart
  const realm = newRealm ?? process.env.KEYCLOAK_REALM ?? "";
  await keycloak.createRealm({
    realm: realm,
    displayName: realm,
    enabled: true,
  });

  if (await keycloak.getUsers(realm)) {
    // Randomly generated passwords will be recreated everytime the tests are restarted
    // We need to clean up the old users so that the new passwords can take affect
    for (const user of Object.values(RBAC_DESCRIPTIVE_USERS)) {
      await keycloak.deleteUser(realm, user.username);
    }
  }

  await keycloak.configureForRHDH({
    realm: realm,
    groups: Object.values(RBAC_GROUPS).filter((g) => g.keycloak),
    users: Object.values(RBAC_DESCRIPTIVE_USERS),
  });
}
