import { test, expect } from "@playwright/test";

/**
 * Temporary test placeholder to check if the e2e test framework setup is working
 * TODO: Remove this test once the actual test is implemented
 */

test("github issues", async ({ page }) => {
  await page.goto("https://github.com/issues");
  await expect(page.locator("body")).toContainText("github");
});
