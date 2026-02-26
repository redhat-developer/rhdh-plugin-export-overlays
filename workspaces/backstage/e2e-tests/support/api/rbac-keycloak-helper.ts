import { KeycloakHelper } from "@red-hat-developer-hub/e2e-test-utils/keycloak";
import { RbacUser } from "../constants/kubernetes/users";

export class RbacKeycloakHelper extends KeycloakHelper {
  async createUsers(users: RbacUser[]): Promise<void> {
    await this.deploy();

    // Clean up users (ignore if none exist yet)
    if (await this.getUsers(process.env.KEYCLOAK_REALM!)) {
      await this.cleanupUsers(users);
    }

    await this.configureForRHDH({
      users: Object.values(users),
    });
  }

  async cleanupUsers(users: RbacUser[]) {
    for (const user of Object.values(users)) {
      await this.deleteUser(process.env.KEYCLOAK_REALM!, user.username);
    }
  }
}
