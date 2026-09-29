/** Login failure when sign-in resolver cannot match a catalog User entity. */
export const NO_USER_FOUND_IN_CATALOG_ERROR_MESSAGE =
  /Login failed; caused by Error: Failed to sign-in, unable to resolve user identity. Please verify that your catalog contains the expected User entities that would match your configured sign-in resolver./u;

export const MICROSOFT_TEST_USERS = {
  zeus: "zeus@rhdhtesting.onmicrosoft.com",
  atena: "atena@rhdhtesting.onmicrosoft.com",
  tyke: "tyke@rhdhtesting.onmicrosoft.com",
} as const;
