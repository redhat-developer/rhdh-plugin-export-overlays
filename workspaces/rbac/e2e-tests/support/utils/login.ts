import { LoginHelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";
import { RbacUser } from "../constants/users-and-groups";

const SIGN_IN_HEADING = "Select a sign-in method";
const LOGIN_ATTEMPTS = 2;

/**
 * The OIDC popup can complete in Keycloak while the main window never stores
 * the session cookie. The app shell can show a sidebar for a moment and then
 * fall back to the sign-in page on the next navigation, which is what
 * `navigateToRBACPage` does. Confirm `/rbac` stays signed in, and retry the
 * popup when it does not.
 */
const sessionSurvivesNavigation = async (
  loginHelper: LoginHelper,
): Promise<boolean> => {
  await loginHelper.page.goto("/rbac");
  await loginHelper.uiHelper.waitForLoad();

  const signIn = loginHelper.page.getByRole("heading", {
    name: SIGN_IN_HEADING,
  });
  const sidebar = loginHelper.page
    .getByLabel("sidebar nav")
    .getByRole("link")
    .first();
  const signedOut = () => signIn.isVisible().catch(() => false);

  if (await signedOut()) {
    return false;
  }

  try {
    await sidebar.waitFor({ state: "visible", timeout: 15_000 });
  } catch {
    return false;
  }

  // A late auth redirect replaces the shell after the sidebar first appears.
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  return !(await signedOut());
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
