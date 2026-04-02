import { test, expect } from "@red-hat-developer-hub/e2e-test-utils/test";

test.describe("Test Quick Start plugin", () => {
  test.beforeAll(async ({ rhdh }) => {
    await rhdh.configure({ auth: "keycloak" });
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
    await uiHelper.verifyButtonURL(
      "Learn more",
      "https://docs.redhat.com/en/documentation/red_hat_developer_hub/latest/html/authentication_in_red_hat_developer_hub/",
      { exact: false },
    );

    await uiHelper.clickButtonByText("Configure RBAC");
    await uiHelper.verifyTextVisible("Assign roles and permissions");
    await uiHelper.verifyButtonURL("Manage access", "/rbac");

    await uiHelper.clickButtonByText("Configure Git");
    await uiHelper.verifyTextVisible("Connect your Git providers");
    await uiHelper.verifyButtonURL(
      "Learn more",
      "https://docs.redhat.com/en/documentation/red_hat_developer_hub/latest/html/integrating_red_hat_developer_hub_with_github/",
      { exact: false },
    );

    await uiHelper.clickButtonByText("Manage plugins");
    await uiHelper.verifyTextVisible("Browse and install extensions");
    await uiHelper.verifyButtonURL("Explore plugins", "/extensions");
    await uiHelper.clickButtonByText("Explore plugins");
    await uiHelper.verifyText("Catalog");
    await uiHelper.verifyText(/Plugins \((\d+)\)/);
    await uiHelper.verifyText("25% progress");

    await uiHelper.clickButton("Hide");
    await expect(page.getByRole("button", { name: "Hide" })).toBeHidden();
  });

  test("Access Quick start as User", async ({ loginHelper, uiHelper }) => {
    await loginHelper.loginAsKeycloakUser();
    await uiHelper.verifyText("Let's get you started with Developer Hub");
    await uiHelper.verifyText("We'll guide you through a few quick steps");

    await uiHelper.clickButtonByText("Import application");
    await uiHelper.verifyTextVisible("Import your existing code");
    await uiHelper.verifyButtonURL("Import", "/bulk-import");

    await uiHelper.clickButtonByText("Learn about the Catalog");
    await uiHelper.verifyTextVisible("Discover all software components");
    await uiHelper.verifyButtonURL("View Catalog", "/catalog");
    await uiHelper.clickButtonByText("View Catalog");
    await uiHelper.verifyHeading(/All components \((\d+)\)/);

    await uiHelper.clickButtonByText("Explore Self-service templates");
    await uiHelper.verifyTextVisible("Use our self-service templates");
    await uiHelper.verifyButtonURL("Explore templates", "/create");
    await uiHelper.clickButtonByText("Explore templates");
    await uiHelper.verifyHeading("Self-service");

    await uiHelper.clickButtonByText("Find all Learning Paths");
    await uiHelper.verifyTextVisible("Integrate tailored e-learning");
    await uiHelper.verifyButtonURL("View Learning Paths", "/learning-paths");
    await uiHelper.clickButtonByText("View Learning Paths");
    await uiHelper.verifyHeading("Learning Paths");
    await uiHelper.verifyText("75% progress");
  });
});
