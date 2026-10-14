import { LoginHelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";
import { RbacUser } from "../constants/users-and-groups";

const SIGN_IN_HEADING = "Select a sign-in method";
const LOGIN_ATTEMPTS = 2;

/**
 * The OIDC popup can finish while the main window falls back to the sign-in
 * page. A full page load is what drops the session, so this check stays on
 * the page login already opened and retries the popup if that page is signed
 * out. A later `page.goto` is then the first document load after login.
 */
const sessionIsActive = async (loginHelper: LoginHelper): Promise<boolean> => {
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
      if (await sessionIsActive(loginHelper)) {
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
