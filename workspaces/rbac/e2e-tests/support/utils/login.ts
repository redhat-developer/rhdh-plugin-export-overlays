import { LoginHelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";
import { RbacUser } from "../constants/users-and-groups";

const SIGN_IN_HEADING = "Select a sign-in method";
const LOGIN_ATTEMPTS = 2;

/**
 * The OIDC popup can complete in Keycloak while the main window never stores
 * the session cookie. A full navigation then lands back on the sign-in page.
 * Confirm the session survives that navigation, and retry the popup when it
 * does not.
 */
const sessionSurvivesNavigation = async (
  loginHelper: LoginHelper,
): Promise<boolean> => {
  await loginHelper.page.goto("/");
  await loginHelper.uiHelper.waitForLoad();

  const stillSignedOut = await loginHelper.page
    .getByRole("heading", { name: SIGN_IN_HEADING })
    .isVisible()
    .catch(() => false);
  if (stillSignedOut) {
    return false;
  }

  await loginHelper.page
    .getByLabel("sidebar nav")
    .getByRole("link")
    .first()
    .waitFor({ state: "visible" });
  return true;
};

export const loginAs = async (
  loginHelper: LoginHelper,
  user: RbacUser,
): Promise<void> => {
  let lastError: unknown;

  for (let attempt = 1; attempt <= LOGIN_ATTEMPTS; attempt++) {
    try {
      await loginHelper.loginAsKeycloakUser(user.username, user.password);
      if (await sessionSurvivesNavigation(loginHelper)) {
        return;
      }
      lastError = new Error(
        `OIDC sign-in did not establish a session for ${user.username}`,
      );
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(
    `OIDC sign-in did not establish a session for ${user.username} after ${LOGIN_ATTEMPTS} attempts`,
    { cause: lastError },
  );
};
