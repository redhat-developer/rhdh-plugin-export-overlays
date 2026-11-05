import { expect, type Page } from "@playwright/test";

/**
 * Verifies that a link's href contains the expected URL.
 * Mirrors UIhelper.verifyButtonURL for elements that use role="link".
 */
export async function verifyLinkURL(
  page: Page,
  label: string | RegExp,
  url: string | RegExp,
  options: { locator?: string; exact?: boolean } = {
    locator: "",
    exact: true,
  },
): Promise<void> {
  const baseLocator =
    !options.locator || options.locator === ""
      ? page
      : page.locator(options.locator);

  const linkUrl = await baseLocator
    .getByRole("link", { name: label, exact: options.exact })
    .first()
    .getAttribute("href");

  expect(linkUrl).toContain(url);
}
