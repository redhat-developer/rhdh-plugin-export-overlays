import { test } from "@red-hat-developer-hub/e2e-test-utils/test";

// https://github.com/RoadieHQ/roadie-backstage-plugins/tree/main/plugins/scaffolder-actions/scaffolder-backend-module-http-request
// Pre-req: Enable roadiehq-scaffolder-backend-module-http-request-dynamic plugin
test.describe("Testing scaffolder-backend-module-http-request to invoke an external request", () => {
  test.beforeAll(async ({ rhdh }) => {
    test.info().annotations.push({
      type: "component",
      description: "plugins",
    });

    await rhdh.configure({
      auth: "guest",
      appConfig: "tests/config/http-request/app-config-rhdh.yaml",
      dynamicPlugins: "tests/config/http-request/dynamic-plugins.yaml",
    });
    await rhdh.deploy();
  });

  test.beforeEach(async ({ loginHelper }) => {
    await loginHelper.loginAsGuest();
  });

  test("Create a software template using http-request plugin", async ({
    uiHelper,
  }) => {
    test.setTimeout(130000);
    await uiHelper.clickLink({
      ariaLabel: "Self-service",
    });
    await uiHelper.verifyHeading("Self-service");
    await uiHelper.verifyHeading("Templates");

    await uiHelper.openSidebar("Catalog");
    await uiHelper.selectMuiBox("Kind", "Template");
    await uiHelper.searchInputPlaceholder("Test HTTP Request");
    await uiHelper.clickLink("Test HTTP Request");
    await uiHelper.verifyHeading("Test HTTP Request");
    await uiHelper.clickLink("Launch Template");
    await uiHelper.verifyHeading("Self-service");
    await uiHelper.clickButton("Create");
    //Checking for Http Status 200
    await uiHelper.verifyText("200", false);
  });
});
