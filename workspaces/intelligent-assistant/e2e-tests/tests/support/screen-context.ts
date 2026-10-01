import { expect, type Page } from "@playwright/test";
import { openChatbotSettings } from "./chat-management";

export const screenContextChip = (page: Page) =>
  page.locator(".lightspeed-page-context-label");

export async function expectScreenContextChipHidden(page: Page): Promise<void> {
  await expect(screenContextChip(page)).toHaveCount(0);
}

export async function expectScreenContextRecordingVisible(
  page: Page,
): Promise<void> {
  await expect(
    page.locator(".lightspeed-page-context-label-recording"),
  ).toBeVisible();
}

export async function expectScreenContextPausedVisible(
  page: Page,
): Promise<void> {
  await expect(
    page.locator(".lightspeed-page-context-label-paused"),
  ).toBeVisible();
}

export async function verifyEnableScreenContextOption(
  page: Page,
): Promise<void> {
  await expect(
    page.getByRole("menuitem", {
      name: "Enable screen context Screen context sharing is currently disabled",
    }),
  ).toBeVisible();
}

export async function verifyDisableScreenContextOption(
  page: Page,
): Promise<void> {
  await expect(
    page.getByRole("menuitem", {
      name: "Disable screen context Screen context sharing is currently enabled",
    }),
  ).toBeVisible();
}

export async function selectEnableScreenContext(page: Page): Promise<void> {
  await page.getByRole("menuitem", { name: "Enable screen context" }).click();
}

export async function selectDisableScreenContext(page: Page): Promise<void> {
  await page.getByRole("menuitem", { name: "Disable screen context" }).click();
}

export async function enableScreenContextViaKebab(page: Page): Promise<void> {
  await openChatbotSettings(page);
  await verifyEnableScreenContextOption(page);
  await selectEnableScreenContext(page);
  await expectScreenContextRecordingVisible(page);
}

export async function disableScreenContextViaKebab(page: Page): Promise<void> {
  await openChatbotSettings(page);
  await verifyDisableScreenContextOption(page);
  await selectDisableScreenContext(page);
  await expectScreenContextChipHidden(page);
}

export async function pauseScreenContextChip(page: Page): Promise<void> {
  await page.locator(".lightspeed-page-context-label-recording").click();
}

export async function resumeScreenContextChip(page: Page): Promise<void> {
  await page.locator(".lightspeed-page-context-label-paused").click();
}
