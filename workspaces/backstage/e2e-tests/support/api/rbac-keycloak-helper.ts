import { KeycloakHelper } from "@red-hat-developer-hub/e2e-test-utils/keycloak";
import { RbacUser } from "../constants/kubernetes/users";
import { requireEnv } from "../utils/require-env";

export class RbacKeycloakHelper extends KeycloakHelper {
  async createUsers(users: RbacUser[]): Promise<void> {
    requireEnv("KEYCLOAK_REALM");
    const realm = process.env.KEYCLOAK_REALM!;
    await this.deploy();

    // Clean up users (ignore if none exist yet)
    if (await this.getUsers(realm)) {
      for (const user of Object.values(users)) {
        await this.deleteUser(realm, user.username);
      }
    }

    await this.configureForRHDH({
      users: Object.values(users),
    });
  }
}
