import { LoginHelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";
import { RbacUser } from "../constants/users-and-groups";

export const loginAs = (
  loginHelper: LoginHelper,
  user: RbacUser,
): Promise<void> =>
  loginHelper.loginAsKeycloakUser(user.username, user.password);
