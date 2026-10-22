import { test, expect } from "@red-hat-developer-hub/e2e-test-utils/test";
import { verifyLinkURL } from "../utils/quickstart";

test.describe("Test Quick Start plugin", () => {
  test.beforeAll(async ({ rhdh }) => {
    await rhdh.configure({
      auth: "keycloak",
      disablePlugins: ["red-hat-developer-hub-backstage-plugin-quickstart"],
    });
    await rhdh.deploy();
  });

  test("Access Quick start as Guest or Admin", async ({
    loginHelper,
    page,
    uiHelper,
  }) => {
    await loginHelper.loginAsGuest();
    await uiHelper.verifyText("Let's get you started with Developer Hub");
    await uiHelper.verifyText("We'll guide you through a few quick steps");
    await uiHelper.verifyText("Not started");

    await uiHelper.clickButtonByText("Set up authentication");
    await uiHelper.verifyTextVisible("Set up secure login credentials");
    await verifyLinkURL(
      page,
      "Learn more",
      "https://docs.redhat.com/en/documentation/red_hat_developer_hub/latest/html/authentication_in_red_hat_developer_hub/",
      { exact: false },
    );

    await uiHelper.clickButtonByText("Configure RBAC");
    await uiHelper.verifyTextVisible("Assign roles and permissions");
    await verifyLinkURL(page, "Manage access", "/rbac");

    await uiHelper.clickButtonByText("Configure Git");
    await uiHelper.verifyTextVisible("Connect your Git providers");
    await verifyLinkURL(
      page,
      "Learn more",
      "https://docs.redhat.com/en/documentation/red_hat_developer_hub/latest/html/integrating_red_hat_developer_hub_with_github/",
      { exact: false },
    );

    await uiHelper.clickButtonByText("Manage plugins");
    await uiHelper.verifyTextVisible("Browse and install extensions");
    await verifyLinkURL(page, "Explore plugins", "/extensions");
    await uiHelper.clickLink("Explore plugins");
    await expect(page).toHaveURL("/extensions");

    await uiHelper.clickButtonByText("Set up Intelligent Assistant");
    await uiHelper.verifyTextVisible(
      "Connect Intelligent Assistant to a supported large language model",
    );
    await verifyLinkURL(
      page,
      "Learn more",
      "https://docs.redhat.com/en/documentation/red_hat_developer_hub/latest/html/interacting_with_red_hat_developer_lightspeed_for_red_hat_developer_hub/",
      {
        exact: false,
        locator: 'li:has-text("Set up Intelligent Assistant")',
      },
    );
    await uiHelper.verifyText("20% progress");

    await uiHelper.clickButton("Hide");
    await expect(page.getByRole("button", { name: "Hide" })).toBeHidden();
  });

  test("Access Quick start as User", async ({
    loginHelper,
    page,
    uiHelper,
  }) => {
    await loginHelper.loginAsKeycloakUser();
    await uiHelper.verifyText("Let's get you started with Developer Hub");
    await uiHelper.verifyText("We'll guide you through a few quick steps");

    await uiHelper.clickButtonByText("Import application");
    await uiHelper.verifyTextVisible("Import your existing code");
    await verifyLinkURL(page, "Import", "/bulk-import");

    await uiHelper.clickButtonByText("Learn about the Catalog");
    await uiHelper.verifyTextVisible("Discover all software components");
    await verifyLinkURL(page, "View Catalog", "/catalog");
    await uiHelper.clickLink("View Catalog");
    await uiHelper.verifyHeading(/All components \((\d+)\)/);

    await uiHelper.clickButtonByText("Explore Self-service templates");
    await uiHelper.verifyTextVisible("Use our self-service templates");
    await verifyLinkURL(page, "Explore templates", "/create");
    await uiHelper.clickLink("Explore templates");
    await uiHelper.verifyHeading("Self-service");

    await uiHelper.clickButtonByText("Find all Learning Paths");
    await uiHelper.verifyTextVisible("Integrate tailored e-learning");
    await verifyLinkURL(page, "View Learning Paths", "/learning-paths");
    await uiHelper.clickLink("View Learning Paths");
    await uiHelper.verifyHeading("Learning Paths");
    await expect(page).toHaveURL("/learning-paths");

    await uiHelper.clickButtonByText("Get started with Intelligent Assistant");
    await uiHelper.verifyTextVisible("Troubleshoot issues, generate code");
    await verifyLinkURL(
      page,
      "Learn more",
      "https://docs.redhat.com/en/documentation/red_hat_developer_hub/latest/html/interacting_with_red_hat_developer_lightspeed_for_red_hat_developer_hub/",
      {
        exact: false,
        locator: 'li:has-text("Get started with Intelligent Assistant")',
      },
    );
    await uiHelper.verifyText("60% progress");
  });
});
