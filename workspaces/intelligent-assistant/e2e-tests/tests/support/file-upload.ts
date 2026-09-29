import { expect, type Locator, type Page } from "@playwright/test";

export const supportedFileTypes = [".txt", ".yaml", ".json"];

export async function uploadFiles(
  page: Page,
  filePaths: string[],
): Promise<void> {
  const attachButton = page.getByRole("button", { name: "Attach" });
  await expect(attachButton).toBeVisible();

  const fileInput = page.locator('input[data-testid="attachment-input"]');
  await fileInput.evaluate((el: HTMLInputElement) => {
    el.value = "";
  });
  await fileInput.setInputFiles(filePaths);
}

export async function uploadAndAssertDuplicate(
  page: Page,
  filePath: string,
  fileName: string,
): Promise<void> {
  await expect(page.getByRole("button", { name: fileName })).toBeVisible();
  await uploadFiles(page, [filePath]);

  await expect(
    page.getByRole("heading", { name: "File upload failed" }),
  ).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("File already exists.")).toBeVisible();
}

export async function validateFailedUpload(page: Page): Promise<void> {
  const alertHeader = page.getByText("File upload failed");
  const alertText = page.getByText(
    "Unsupported file type. Supported types are: .txt, .yaml, and .json.",
  );

  await expect(alertHeader).toBeVisible();
  await expect(alertText).toBeVisible();

  const closeButton = page.getByRole("button", { name: "Close Danger alert" });
  await closeButton.evaluate((el: HTMLElement) => el.click());
  await expect(alertHeader).toBeHidden();
  await expect(alertText).toBeHidden();
}

export async function assertVisibilityState(
  state: "visible" | "hidden",
  ...locators: Locator[]
): Promise<void> {
  for (const locator of locators) {
    await expect(locator)[state === "visible" ? "toBeVisible" : "toBeHidden"]();
  }
}
