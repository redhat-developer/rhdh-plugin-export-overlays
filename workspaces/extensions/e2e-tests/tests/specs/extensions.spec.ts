import { test, expect } from "@red-hat-developer-hub/e2e-test-utils/test";
import type { UIhelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";
import { ExtensionsPage } from "../support/extensions";

test.describe("Admin > Extensions", () => {
  let extensions: ExtensionsPage;
  let uiHelper: UIhelper;
  const isMac = process.platform === "darwin";

  const commonHeadings = [
    "Versions",
    "Author",
    "Tags",
    "Category",
    "Publisher",
    "Support Provider",
  ];
  // only GA plugins available for now
  const supportTypeOptions = [
    "Generally available (GA)",
    // "Tech preview (TP)",
    // "Dev preview (DP)",
    // "Community plugin",
  ];
  const provider = "Red Hat";

  test.beforeAll(async ({ rhdh }) => {
    test.setTimeout(300_000);
    await rhdh.configure({
      auth: "keycloak",
    });
    await rhdh.deploy();
  });

  test.beforeEach(async ({ page, loginHelper, uiHelper: u }) => {
    uiHelper = u;
    extensions = new ExtensionsPage(page, uiHelper);
    await loginHelper.loginAsKeycloakUser();
    await uiHelper.openSidebarButton("Administration");
    await uiHelper.openSidebar("Extensions");
    await uiHelper.verifyHeading("Extensions");
  });

  test.describe("Extensions > Catalog", () => {
    // eslint-disable-next-line playwright/expect-expect -- uiHelper.verifyHeading asserts internally
    test("Verify search bar in extensions", async ({ page }) => {
      await extensions.searchExtensions("Dynatrace");
      await uiHelper.verifyHeading("DynaTrace");
      await page
        .getByRole("button", {
          name: "Clear Search",
        })
        .click();
    });

    test("Verify category and author filters in extensions", async ({
      page,
      uiHelper,
    }) => {
      const category = "Analytics";
      const plugin = "Adoption Insights for Red Hat Developer Hub";
      const author = "Red Hat";

      await uiHelper.verifyHeading(new RegExp(`^${"Plugins"} \\(\\d+\\)$`));

      await uiHelper.clickTab("Catalog");
      await extensions.selectDropdown("Category");
      await extensions.toggleOption(category);
      await page.getByRole("option", { name: category }).isChecked();
      await page.keyboard.press(`Escape`);
      await extensions.selectDropdown("Author");
      await extensions.toggleOption(author);
      await page.keyboard.press(`Escape`);
      await uiHelper.verifyHeading(plugin);
      await uiHelper.verifyText(` by ${author}`);
      await page.getByRole("heading", { name: plugin }).click();
      await uiHelper.verifyTableHeadingAndRows([
        "Package name",
        "Version",
        "Role",
        "Backstage compatibility version",
        "Status",
      ]);
      await uiHelper.verifyHeading("Versions");
      await page
        .getByRole("button", {
          name: "close",
        })
        .click();
      await uiHelper.clickLink("Read more");
      await page
        .getByRole("button", {
          name: "close",
        })
        .click();
      await extensions.selectDropdown("Author");
      await extensions.toggleOption(author);
      await expect(
        page.getByRole("option", { name: author }).getByRole("checkbox"),
      ).not.toBeChecked();
      await expect(page.getByRole("button", { name: author })).toBeHidden();
      await page.keyboard.press(`Escape`);
      await expect(
        page.getByLabel("Category").getByRole("combobox"),
      ).toBeEmpty();
      await page.keyboard.press(`Escape`);
    });

    test("Verify support type filters in extensions", async ({ page }) => {
      await extensions.selectDropdown("Support type");
      await expect(page.getByRole("listbox")).toBeVisible();

      // Verify all support type options are present using filter for partial text matching
      for (const option of supportTypeOptions) {
        const optionLocator = page
          .getByRole("option")
          .filter({ hasText: option });
        await expect(optionLocator).toBeVisible();
      }

      await page.keyboard.press("Escape");
      await expect(
        page.getByLabel("Category").getByRole("combobox"),
      ).toBeEmpty();
    });

    test("Verify Generally available badge in extensions", async ({
      page,
      uiHelper,
    }) => {
      await extensions.selectSupportTypeFilter("Generally available (GA)");

      await expect(
        page
          .getByLabel(`Generally available (GA) and supported by ${provider}`)
          .first(),
      ).toBeVisible();
      await expect(extensions.badge.first()).toBeVisible();
      await extensions.badge.first().hover();
      await uiHelper.verifyTextInTooltip(
        `Generally available (GA) and supported by ${provider}`,
      );

      await uiHelper.clickLink("Read more");
      await expect(
        page
          .getByLabel(`Production-ready and supported by ${provider}`)
          .getByText("Generally available (GA)"),
      ).toBeVisible();

      for (const heading of commonHeadings) {
        await uiHelper.verifyHeading(heading);
      }

      await page
        .getByRole("button", {
          name: "close",
        })
        .click();

      await extensions.resetSupportTypeFilter("Generally available (GA)");
    });

    // eslint-disable-next-line playwright/expect-expect -- assertions inside ExtensionsPage.verifySupportTypeBadge
    test.skip("Verify tech preview badge in extensions", async () => {
      await extensions.verifySupportTypeBadge({
        supportType: "Tech preview (TP)",
        pluginName: "Bulk Import",
        badgeLabel: "Plugin still in development",
        badgeText: "Tech preview (TP)",
        tooltipText: "",
        searchTerm: "Bulk Import",
        headings: ["About", "Versions", ...commonHeadings],
        includeTable: true,
        includeAbout: false,
      });
    });

    // eslint-disable-next-line playwright/expect-expect -- assertions inside ExtensionsPage helpers
    test.skip("Verify dev preview badge in extensions", async () => {
      await extensions.selectSupportTypeFilter("Dev preview (DP)");
      await uiHelper.verifyHeading("Konflux");

      await extensions.verifyPluginDetails({
        pluginName: "Konflux",
        badgeLabel: "An early-stage, experimental plugin",
        badgeText: "Dev preview (DP)",
        headings: commonHeadings,
        includeTable: true,
        includeAbout: false,
      });

      await extensions.resetSupportTypeFilter("Dev preview (DP)");
    });

    test.skip("Verify community plugin badge in extensions", async ({
      page,
      uiHelper,
    }) => {
      await extensions.selectSupportTypeFilter("Community plugin");

      await extensions.clickReadMoreByPluginTitle(
        "ServiceNow Integration for Red Hat Developer Hub",
        "Community plugin",
      );
      await expect(
        page
          .getByLabel("Open-source plugins, no official support")
          .getByText("Community plugin"),
      ).toBeVisible();

      await uiHelper.verifyText("About");
      for (const heading of commonHeadings) {
        await uiHelper.verifyHeading(heading);
      }

      await expect(page.getByText("Author" + "Red Hat")).toBeVisible();

      await page
        .getByRole("button", {
          name: "close",
        })
        .click();
      await extensions.resetSupportTypeFilter("Community plugin");
    });

    test.use({
      permissions: ["clipboard-read", "clipboard-write"],
    });

    test("Verify plugin configuration can be viewed in the production environment", async ({
      page,
      uiHelper,
    }) => {
      const plugin = "Adoption Insights for Red Hat Developer Hub";
      const packageName =
        "oci://quay.io/rhdh/red-hat-developer-hub-backstage-plugin-adoption-insights";

      await extensions.searchExtensions(plugin);
      await extensions.waitForSearchResults(plugin);
      await extensions.clickReadMoreByPluginTitle(
        plugin,
        "Generally available (GA)",
      );

      await uiHelper.clickButton("Actions");
      await page.getByText("Edit").click();
      await uiHelper.verifyHeading(plugin);
      await uiHelper.verifyText(`- package: ${packageName}`, false);

      await uiHelper.verifyText(/^\s+(disabled:\sfalse|enabled:\strue)/);
      await uiHelper.verifyText("Apply");
      await uiHelper.verifyHeading("Default configuration");
      await uiHelper.clickButton("Apply");
      await uiHelper.verifyText("pluginConfig:");
      await uiHelper.verifyText("dynamicPlugins:");

      await uiHelper.clickTab("About the plugin");
      await uiHelper.verifyHeading("Configuring The Plugin");
      await uiHelper.clickTab("Examples");

      await uiHelper.clickByDataTestId("ContentCopyRoundedIcon");
      await expect(page.getByRole("button", { name: "✔" })).toBeVisible();
      await uiHelper.clickButton("Reset");
      await expect(page.getByText("pluginConfig:")).toBeHidden();

      // eslint-disable-next-line playwright/no-conditional-in-test
      const modifier = isMac ? "Meta" : "Control";
      await page.keyboard.press(`${modifier}+KeyA`);
      await page.keyboard.press(`${modifier}+KeyV`);
      await uiHelper.verifyText("pluginConfig:");
      await uiHelper.clickByDataTestId("ContentCopyRoundedIcon");
      await expect(page.getByRole("button", { name: "✔" })).toBeVisible();

      const clipboardContent = await page.evaluate(() =>
        navigator.clipboard.readText(),
      );
      expect(clipboardContent).toContain("pluginConfig:");
      expect(clipboardContent).toContain(
        "red-hat-developer-hub.backstage-plugin-adoption-insights:",
      );

      await uiHelper.clickButton("Cancel");
      await expect(
        page.getByRole("button", {
          name: new RegExp(`^${"Actions"}$`),
        }),
      ).toBeVisible();
      await uiHelper.verifyHeading(plugin);
    });

    test("Enable plugin from catalog extension page", async ({
      page,
      uiHelper,
    }) => {
      const plugin = "Adoption Insights for Red Hat Developer Hub";

      await uiHelper.clickByDataTestId("header-tab-0");
      await extensions.clickReadMoreByPluginTitle(
        plugin,
        "Generally available (GA)",
      );
      await uiHelper.verifyHeading(plugin);
      await page.getByTestId("plugin-actions").click();
      await expect(page.getByLabel("EditPlugin")).toBeVisible();
      await page.getByTestId("disable-plugin").click();
      await expect(page.getByTestId("enable-plugin")).toBeVisible();

      await expect(page.getByRole("alert")).toContainText(
        `The ${plugin} plugin requires a restart of the backend system to finish installing, updating, enabling or disabling.`,
      );
    });
  });

  test.describe("Extensions > Installed Plugin", () => {
    const plugin = "TechDocs Add-ons Contrib";
    const npmPackage =
      /@backstage\/plugin-techdocs-module-addons-contrib-dynamic/;

    test.beforeEach(async ({ uiHelper }) => {
      await uiHelper.clickByDataTestId("header-tab-1");
      await uiHelper.verifyHeading(
        new RegExp(`^${"Installed packages"} \\(\\d+\\)$`),
      );
    });

    test("Installed packages page", async ({ page, uiHelper }) => {
      await expect(page.getByRole("cell").nth(2)).toBeVisible();
      await uiHelper.verifyTableHeadingAndRows([
        "Name",
        "npm package name",
        "Role",
        "Version",
        "Actions",
      ]);
      await page
        .getByRole("button", {
          name: "Name",
          exact: true,
        })
        .click();
      await uiHelper.verifyRowInTableByUniqueText(plugin, [
        npmPackage,
        /Frontend plugin module/,
        /\d{1,10}\.\d{1,10}\.\d{1,10}/,
      ]);

      const techdocsRow = page.getByRole("row", {
        name: npmPackage,
      });
      await expect(techdocsRow).toBeVisible();
      await expect(
        techdocsRow.getByLabel("Edit package configuration"),
      ).toBeVisible();
      await expect(
        techdocsRow.getByLabel("Download package configuration"),
      ).toBeVisible();
      await expect(techdocsRow.getByLabel("Disable package")).toBeVisible();

      await page
        .getByRole("button", {
          name: new RegExp(`5 rows`),
        })
        .click();
      await page.getByRole("option", { name: "10", exact: true }).click();
      await page
        .getByRole("button", {
          name: new RegExp(`10 rows`),
        })
        .scrollIntoViewIfNeeded();
      await expect(
        page.getByRole("button", {
          name: new RegExp(`10 rows`),
        }),
      ).toBeVisible();

      await expect(
        page.getByRole("button", { name: "Next Page" }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Previous Page" }),
      ).toBeVisible();
    });

    test("Package sidebar", async ({ page }) => {
      await extensions.searchPackages(plugin);

      const row = page.getByRole("row", { name: plugin });
      await expect(row.getByLabel("Edit package configuration")).toBeVisible();
      await expect(
        row.getByLabel("Download package configuration"),
      ).toBeVisible();
      await expect(row.getByRole("checkbox")).toBeVisible();
      await page
        .getByRole("link", {
          name: plugin,
        })
        .click();
      await expect(
        page.getByRole("heading", {
          name: plugin,
        }),
      ).toBeVisible();

      await expect(page.getByRole("button", { name: "Action" })).toBeVisible();
      await page.getByTestId("plugin-actions").hover();
      await page.getByRole("button", { name: "close" }).click();
      await expect(
        page
          .getByRole("cell", {
            name: "Edit package configuration",
          })
          .first(),
      ).toBeVisible();
    });

    test.describe("Edit package", () => {
      const plugin = "Analytics provider segment";
      const npmPackage = /plugin-analytics-provider-segment/;
      const configLine = "testMode: ${SEGMENT_TEST_MODE}";

      test.beforeEach(async () => {
        await extensions.searchPackages(plugin);
      });

      test("Edit package through side menu", async ({ page, uiHelper }) => {
        const link = page.getByRole("link", { name: plugin });
        await expect(link).toBeVisible();
        await link.click();

        await page.getByTestId("plugin-actions").click();
        await page.getByTestId("edit-configuration").click();
        await expect(
          page.getByRole("heading", { name: "Instructions" }),
        ).toBeVisible();
        await uiHelper.verifyHeading(npmPackage);
        await expect(page.getByText("SaveCancelReset")).toBeVisible();
        await expect(
          page.getByText('plugins: - package: "oci://'),
        ).toBeVisible();
        await page
          .getByRole("button", {
            name: "Apply",
          })
          .click();
        await expect(page.getByRole("code").first()).toContainText(configLine);
        await page
          .getByRole("button", {
            name: "Reset",
          })
          .click();
        await expect(page.getByRole("code").first()).not.toContainText(
          configLine,
        );
        await page
          .getByRole("button", {
            name: "Cancel",
          })
          .click();
        await expect(page.getByRole("heading", { name: plugin })).toBeVisible();
        await page.getByRole("button", { name: "close" }).click();
      });

      test("Edit package through action cell in the installed package row", async ({
        page,
        uiHelper,
      }) => {
        await extensions.searchPackages(plugin);

        await page
          .getByRole("button", {
            name: "Edit package configuration",
          })
          .click();
        await expect(
          page.getByRole("heading", { name: `Edit ${plugin}` }),
        ).toBeVisible();
        await expect(page.getByText("SaveCancelReset")).toBeVisible();
        await expect(
          page.getByText('plugins: - package: "oci://'),
        ).toBeVisible();

        await page.getByRole("button", { name: "Apply" }).click();
        await expect(page.getByRole("code").first()).toContainText(configLine);
        await page
          .getByRole("button", {
            name: "Save",
          })
          .click();
        await uiHelper.verifyHeading(
          new RegExp(`^${"Installed packages"} \\(\\d+\\)$`),
          10000,
        );
        await expect(page.getByRole("alert").first()).toContainText(
          `The ${plugin} package requires a restart of the backend system to finish installing, updating, enabling or disabling.`,
          { timeout: 10000, ignoreCase: true },
        );
      });
    });

    test("Plugin enable-disable toggle in action cell in the installed package row", async ({
      page,
    }) => {
      const scaffolderPlugin = "Scaffolder Backend Module Regex";
      const scaffolderPackage =
        "@backstage-community/plugin-scaffolder-backend-module-regex-dynamic";
      const headerPlugin = "Global Header";
      const headerPackage =
        "@red-hat-developer-hub/backstage-plugin-global-header-dynamic";

      await extensions.searchPackages(scaffolderPlugin);
      await page.getByRole("checkbox").hover();
      await expect(page.getByLabel("Disable package")).toBeVisible();
      await page.getByRole("checkbox").click();
      await expect(page.getByRole("alert").first()).toContainText(
        `The ${scaffolderPackage} package requires a restart of the backend system to finish installing, updating, enabling or disabling.`,
        { timeout: 15000 },
      );

      await extensions.searchPackages(headerPlugin);
      await page.getByRole("checkbox").hover();
      await expect(page.getByLabel("Disable package")).toBeVisible();
      await page.getByRole("checkbox").click();

      await page
        .getByRole("button", {
          name: "View packages",
        })
        .click();
      await expect(
        page
          .getByLabel("Backend restart required")
          .getByText("Backend restart required"),
      ).toBeVisible({ timeout: 10000 });

      const packageVerifications = [
        { rowTitle: "Name", rowValue: "Action" },
        {
          rowTitle: scaffolderPackage,
          rowValue: "Package disabled",
        },
        {
          rowTitle: headerPackage,
          rowValue: "Package disabled",
        },
      ];

      for (const { rowTitle, rowValue } of packageVerifications) {
        await extensions.verifyKeyValueRowElements(rowTitle, rowValue);
      }

      await expect(page.getByText("To finish the package")).toBeVisible();
      await page.getByRole("button", { name: "close", exact: true }).click();
    });
  });
});
