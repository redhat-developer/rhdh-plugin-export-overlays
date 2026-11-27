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

  const config = {
    realm: realm,
    groups: Object.values(RBAC_GROUPS).filter((g) => g.keycloak),
    users: Object.values(RBAC_DESCRIPTIVE_USERS),
  };

  // The shared Keycloak occasionally drops the connection mid-setup
  // ("SocketError: other side closed"). configureForRHDH skips entities that
  // already exist, so retrying absorbs a transient drop instead of aborting
  // the whole suite before RHDH is deployed.
  const maxAttempts = 3;
  for (let attempt = 1; ; attempt++) {
    try {
      await keycloak.configureForRHDH(config);
      return;
    } catch (error) {
      if (attempt >= maxAttempts) throw error;
      console.warn(
        `[Keycloak] configureForRHDH attempt ${attempt}/${maxAttempts} failed: ${(error as Error).message}; retrying in 5s`,
      );
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }
}
