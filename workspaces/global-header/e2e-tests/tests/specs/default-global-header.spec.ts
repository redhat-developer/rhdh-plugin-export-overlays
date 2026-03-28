import {
  expect,
  test,
  request,
} from "@red-hat-developer-hub/e2e-test-utils/test";
import { NotificationPage } from "@red-hat-developer-hub/e2e-test-utils/pages";

test.describe("Default Global Header", () => {
  test.beforeAll(async ({ rhdh }) => {
    process.env.RHDH_SKIP_PLUGIN_METADATA_INJECTION = "true";

    await rhdh.configure({
      auth: "keycloak",
      appConfig: "tests/config/app-config-rhdh.yaml",
      dynamicPlugins: "tests/config/dynamic-plugins.yaml",
      valueFile: "tests/config/value_file.yaml",
    });
    await rhdh.deploy();
  });

  test.beforeEach(async ({ loginHelper, page }) => {
    await loginHelper.loginAsKeycloakUser(
      process.env.GH_USER2_ID,
      process.env.GH_USER2_PASS,
    );
    await expect(page.getByRole("navigation").first()).toBeVisible();
  });

  test("Verify that global header and default header components are visible", async ({
    page,
    uiHelper,
  }) => {
    await expect(page.getByPlaceholder("Search")).toBeVisible();
    await uiHelper.verifyLink({ label: "Self-service" });

    const globalHeader = page.getByRole("navigation").first();
    const helpDropdownButton = globalHeader
      .getByRole("button", {
        name: "Help",
      })
      .or(
        globalHeader.getByRole("button").filter({
          has: page.getByTestId("HelpOutlineIcon"),
        }),
      )
      .first();

    await expect(helpDropdownButton).toBeVisible();
    await uiHelper.verifyLink({ label: "Notifications" });
    expect(await uiHelper.isBtnVisible("Test User1")).toBeTruthy();
  });

  test("Verify that search modal and settings button in sidebar are not visible", async ({
    uiHelper,
  }) => {
    expect(await uiHelper.isBtnVisible("Search")).toBeFalsy();
    expect(await uiHelper.isBtnVisible("Settings")).toBeFalsy();
  });

  test("Verify that clicking on Self-service button opens the Templates page", async ({
    uiHelper,
  }) => {
    await uiHelper.clickLink({ ariaLabel: "Self-service" });
    await uiHelper.verifyHeading("Self-service");
  });

  test("Verify that clicking on Support button in HelpDropdown opens a new tab", async ({
    uiHelper,
    context,
    page,
  }) => {
    const globalHeader = page.getByRole("navigation").first();

    const helpDropdownButton = globalHeader
      .getByRole("button", {
        name: "Help",
      })
      .or(
        globalHeader.getByRole("button").filter({
          has: page.getByTestId("HelpOutlineIcon"),
        }),
      )
      .first();

    await helpDropdownButton.click();
    await page
      .getByTestId("support-button")
      .waitFor({ state: "visible", timeout: 10000 });
    await uiHelper.verifyTextVisible("Support", false);

    const [newTab] = await Promise.all([
      context.waitForEvent("page"),
      uiHelper.clickByDataTestId("support-button"),
    ]);

    expect(newTab).not.toBeNull();
    await newTab.waitForLoadState();
    expect(newTab.url()).toContain(
      "https://github.com/redhat-developer/rhdh/issues",
    );
    await newTab.close();
  });

  test("Verify Profile Dropdown behaves as expected", async ({
    page,
    uiHelper,
  }) => {
    await uiHelper.openProfileDropdown();
    await uiHelper.verifyLinkVisible("Settings");
    await uiHelper.verifyTextVisible("Sign out");

    await page
      .getByRole("menuitem", {
        name: "Settings",
      })
      .click();
    await uiHelper.verifyHeading("Settings");

    await expect(page.locator("nav[id='global-header']")).toBeVisible();
    await uiHelper.openProfileDropdown();
    await uiHelper.clickLink("My profile");
    await uiHelper.verifyTextInSelector("header > div > p", "user");
    await uiHelper.verifyHeading(process.env.GH_USER2_ID!);
    await expect(
      page.getByRole("tab", {
        name: "Overview",
      }),
    ).toBeVisible();

    await uiHelper.openProfileDropdown();
    await page.getByRole("menu").getByText("Sign out").click();
    await uiHelper.verifyHeading("Select a sign-in method");
  });

  test("Verify Search bar behaves as expected", async ({ page, uiHelper }) => {
    const searchBar = page.getByPlaceholder("Search");
    await searchBar.click();
    await searchBar.fill("test query term");
    expect(await uiHelper.isBtnVisibleByTitle("Clear")).toBeTruthy();
    const dropdownList = page.getByRole("listbox");
    await expect(dropdownList).toBeVisible();
    await searchBar.press("Enter");
    await uiHelper.verifyHeading("Search");

    const searchResultPageInput = page.locator("#search-bar-text-field");
    await expect(searchResultPageInput).toHaveValue("test query term");
  });

  test("Verify Notifications button behaves as expected", async ({
    uiHelper,
    // baseURL,
    // request,
    page,
  }) => {
    const notificationsBadge = page
      .getByRole("navigation")
      .first()
      .getByRole("link", {
        name: "Notifications",
      });

    await uiHelper.clickLink({
      ariaLabel: "Notifications",
    });
    await uiHelper.verifyHeading("Notifications");
    const notificationPage = new NotificationPage(page);
    await notificationPage.markAllNotificationsAsRead();

    // const postResponse = await request.post(`${process.env.RHDH_URL}/api/notifications`, {
    //   headers: {
    //     Accept: "application/json",
    //     "Content-Type": "application/json",
    //     Authorization: "Bearer test-token",
    //   },
    //   data: {
    //     recipients: { type: "broadcast", entityRef: [""] },
    //     payload: {
    //       title: "Demo test notification message!",
    //       link: "http://foo.com/bar", // NOSONAR typescript:S5332 - test fixture URL
    //       severity: "high",
    //       description: "The demo test notification message",
    //       topic: "The topic",
    //     },
    //   },
    // });

    const apiContext = await request.newContext({
      baseURL: `${process.env.RHDH_BASE_URL}/api/`,
      extraHTTPHeaders: {
        Accept: "application/json",
        Authorization: "Bearer test-token",
      },
    });

    const postResponse = await apiContext.post("notifications", {
      data: {
        recipients: { type: "broadcast", entityRef: [""] },
        payload: {
          title: "Demo test notification message!",
          link: "http://foo.com/bar", // NOSONAR typescript:S5332 - test fixture URL
          description: "The demo test notification message",
          severity: "high",
          topic: "The topic",
        },
      },
    });

    expect(
      postResponse.ok(),
      `Failed to create notification. Status: ${postResponse.status()}`,
    ).toBeTruthy();
    await apiContext.dispose();
    // expect(postResponse.status()).toBe(200);

    await expect(notificationsBadge).toHaveText("1");
  });
});
