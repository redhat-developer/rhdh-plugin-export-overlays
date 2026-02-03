import { test, expect, request } from "rhdh-e2e-test-utils/test";
import { CustomAPIHelper } from "../../support/api/api-helper";
import { GitHubEventsHelper } from "../../support/api/github-events";
import { createHmac } from "crypto";

test.describe("GitHub Events Module", () => {
  let githubEventsHelper: GitHubEventsHelper;
  let staticToken: string;
  let rhdhBaseUrl: string;

  test.beforeAll(async ({ rhdh }) => {
    await rhdh.configure({
      auth: "guest",
      appConfig: "tests/config/github-events/app-config-rhdh.yaml",
      secrets: "tests/config/github-events/rhdh-secrets.yaml",
      dynamicPlugins: "tests/config/github-events/dynamic-plugins.yaml",
    });

    await rhdh.deploy();

    // Create request context with SSL verification disabled for self-signed certs
    const apiContext = await request.newContext({
      ignoreHTTPSErrors: true,
    });

    // Get the guest token from RHDH auth endpoint
    const authResponse = await apiContext.get(
      `${rhdh.rhdhUrl}/api/auth/guest/refresh`,
      {
        headers: {
          "Content-Type": "application/json",
        },
      },
    );

    if (!authResponse.ok()) {
      throw new Error(`Failed to get guest token: ${authResponse.status()}`);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const authData = (await authResponse.json()) as any;
    staticToken = authData.backstageIdentity?.token || authData.token;

    if (!staticToken) {
      throw new Error(
        "No token found in auth response: " + JSON.stringify(authData),
      );
    }

    await apiContext.dispose();

    githubEventsHelper = await GitHubEventsHelper.build(
      rhdh.rhdhUrl,
      process.env.VAULT_GITHUB_APP_WEBHOOK_SECRET!,
    );
    rhdhBaseUrl = rhdh.rhdhUrl;
  });

  test.beforeEach(async ({ loginHelper }) => {
    await loginHelper.loginAsGuest();
  });

  test("Events endpoint accepts signed GitHub webhook payloads", async () => {
    const rawBody = JSON.stringify({
      zen: "Test Payload.",
      // eslint-disable-next-line @typescript-eslint/naming-convention
      hook_id: 123456,
      repository: {
        // eslint-disable-next-line @typescript-eslint/naming-convention
        full_name: "test/repo",
      },
      organization: {
        login: "test-org",
      },
    });

    const secret = process.env.VAULT_GITHUB_APP_WEBHOOK_SECRET!;
    const signature =
      "sha256=" +
      createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");

    const context = await request.newContext({
      ignoreHTTPSErrors: true,
    });

    const response = await context.post("/api/events/http/github", {
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "ping",
        "X-GitHub-Delivery": "test-delivery-id",
        // eslint-disable-next-line @typescript-eslint/naming-convention
        "X-Hub-Signature-256": signature,
      },
      data: rawBody,
    });

    expect(response.status()).toBe(202);

    await context.dispose();
  });

  test.describe("GitHub Discovery", () => {
    const catalogRepoName = `janus-test-github-events-test-${Date.now()}`;
    const catalogRepoDetails = {
      name: catalogRepoName,
      url: `github.com/janus-qe/${catalogRepoName}`,
      org: `github.com/janus-qe`,
      owner: "janus-qe",
    };

    test("Adding a new entity to the catalog", async ({ page, uiHelper }) => {
      const catalogInfoYamlContent = `apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: ${catalogRepoName}
  annotations:
    github.com/project-slug: janus-qe/${catalogRepoName}
  description: E2E test component for github events module
spec:
  type: other
  lifecycle: unknown
  owner: user:default/janus-qe`;

      await CustomAPIHelper.createGitHubRepoWithFile(
        catalogRepoDetails.owner,
        catalogRepoDetails.name,
        "catalog-info.yaml",
        catalogInfoYamlContent,
        process.env.VAULT_GH_RHDH_QE_USER_TOKEN!,
      );

      await githubEventsHelper.sendPushEvent(
        `janus-qe/${catalogRepoName}`,
        "added",
      );

      await expect
        .poll(
          async () => {
            await page.reload();
            await uiHelper.openSidebar("Catalog");
            await uiHelper.selectMuiBox("Kind", "Component");
            await uiHelper.searchInputPlaceholder(catalogRepoName);
            return await page
              .getByRole("link", { name: catalogRepoName })
              .isVisible();
          },
          {
            message: `Component ${catalogRepoName} should appear in catalog`,
            timeout: 60000,
            intervals: [10000],
          },
        )
        .toBe(true);
    });

    test("Updating an entity in the catalog", async ({ page, uiHelper }) => {
      const updatedDescription = "updated description";
      const updatedCatalogInfoYaml = `apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: ${catalogRepoName}
  annotations:
    github.com/project-slug: janus-qe/${catalogRepoName}
  description: ${updatedDescription}
spec:
  type: other
  lifecycle: unknown
  owner: user:default/janus-qe`;
      await CustomAPIHelper.updateFileInRepo(
        catalogRepoDetails.owner,
        catalogRepoDetails.name,
        "catalog-info.yaml",
        updatedCatalogInfoYaml,
        "Update catalog-info.yaml description",
        process.env.VAULT_GH_RHDH_QE_USER_TOKEN!,
      );
      await githubEventsHelper.sendPushEvent(
        `janus-qe/${catalogRepoName}`,
        "modified",
      );

      await expect
        .poll(
          async () => {
            await page.reload();
            await uiHelper.openSidebar("Catalog");
            await uiHelper.selectMuiBox("Kind", "Component");
            await uiHelper.searchInputPlaceholder(catalogRepoName);

            await page.getByRole("link", { name: catalogRepoName }).click();
            // wait for page to load
            await uiHelper.waitForLoad(5000);
            return await page.getByText(updatedDescription).isVisible();
          },
          {
            message: `Component ${catalogRepoName} should be updated with new description`,
            timeout: 60000,
            intervals: [10000],
          },
        )
        .toBe(true);
    });

    test("Deleting an entity from the catalog", async ({ page, uiHelper }) => {
      await CustomAPIHelper.deleteFileInRepo(
        catalogRepoDetails.owner,
        catalogRepoDetails.name,
        "catalog-info.yaml",
        "Remove catalog-info.yaml",
        process.env.VAULT_GH_RHDH_QE_USER_TOKEN!,
      );
      await githubEventsHelper.sendPushEvent(
        `janus-qe/${catalogRepoName}`,
        "removed",
      );

      await expect
        .poll(
          async () => {
            await page.reload();
            await uiHelper.openSidebar("Catalog");
            await uiHelper.selectMuiBox("Kind", "Component");
            await uiHelper.searchInputPlaceholder(catalogRepoName);
            return await page
              .getByRole("link", { name: catalogRepoName })
              .isVisible();
          },
          {
            message: `Component ${catalogRepoName} should be removed from catalog`,
            timeout: 60000,
            intervals: [10000],
          },
        )
        .toBe(false);
    });
  });

  test.describe("GitHub Organizational Data", () => {
    // eslint-disable-next-line playwright/max-nested-describe
    test.describe("Teams", () => {
      const teamName = "test-team-" + Date.now();

      test("Adding a new group", async ({ page, uiHelper }) => {
        await CustomAPIHelper.createTeamInOrg(
          "janus-qe",
          teamName,
          process.env.VAULT_GH_RHDH_QE_USER_TOKEN!,
        );
        await githubEventsHelper.sendTeamEvent("created", teamName, "janus-qe");

        await expect
          .poll(
            async () => {
              await page.reload();
              await uiHelper.openSidebar("Catalog");
              await uiHelper.selectMuiBox("Kind", "Group");
              await uiHelper.searchInputPlaceholder(teamName);
              return await page
                .getByRole("link", { name: teamName })
                .isVisible();
            },
            {
              message: `Team ${teamName} should appear in catalog`,
              timeout: 60000,
              intervals: [10000],
            },
          )
          .toBe(true);
      });

      test("Deleting a group", async ({ page, uiHelper }) => {
        await CustomAPIHelper.deleteTeamFromOrg(
          "janus-qe",
          teamName,
          process.env.VAULT_GH_RHDH_QE_USER_TOKEN!,
        );

        await githubEventsHelper.sendTeamEvent("deleted", teamName, "janus-qe");

        await expect
          .poll(
            async () => {
              await page.reload();
              await uiHelper.openSidebar("Catalog");
              await uiHelper.selectMuiBox("Kind", "Group");
              await uiHelper.searchInputPlaceholder(teamName);
              return await page
                .getByRole("link", { name: teamName })
                .isVisible();
            },
            {
              message: `Team ${teamName} should be removed from catalog`,
              timeout: 60000,
              intervals: [10000],
            },
          )
          .toBe(false);
      });
    });

    // eslint-disable-next-line playwright/max-nested-describe
    test.describe("Team Membership", () => {
      let teamCreated = false;
      let userAddedToTeam = false;
      let teamName: string;

      test.beforeEach(async () => {
        teamName = "test-team-" + Date.now();

        await CustomAPIHelper.createTeamInOrg(
          "janus-qe",
          teamName,
          process.env.VAULT_GH_RHDH_QE_USER_TOKEN!,
        );
        teamCreated = true;

        await githubEventsHelper.sendTeamEvent("created", teamName, "janus-qe");

        await new Promise((resolve) => setTimeout(resolve, 2000));
      });

      test.afterEach(async () => {
        if (userAddedToTeam) {
          await CustomAPIHelper.removeUserFromTeam(
            "janus-qe",
            teamName,
            "04kash",
            process.env.VAULT_GH_RHDH_QE_USER_TOKEN!,
          );
          userAddedToTeam = false;
        }

        if (teamCreated) {
          await CustomAPIHelper.deleteTeamFromOrg(
            "janus-qe",
            teamName,
            process.env.VAULT_GH_RHDH_QE_USER_TOKEN!,
          );
          teamCreated = false;
        }
      });

      test("Adding a user to a group", async ({ uiHelper }) => {
        await CustomAPIHelper.addUserToTeam(
          "janus-qe",
          teamName,
          "04kash",
          process.env.VAULT_GH_RHDH_QE_USER_TOKEN!,
        );
        userAddedToTeam = true;

        await githubEventsHelper.sendMembershipEvent(
          "added",
          "04kash",
          teamName,
          "janus-qe",
        );

        await uiHelper.waitForLoad(10000);

        const api = new CustomAPIHelper();
        await api.useStaticToken(staticToken);
        await api.useBaseUrl(rhdhBaseUrl);

        await expect
          .poll(
            async () => {
              const groupEntity = await api.getGroupEntityFromAPI(teamName);
              const members =
                groupEntity.relations
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  ?.filter((r: any) => r.type === "hasMember")
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  .map((r: any) => r.targetRef.split("/")[1]) || [];
              return members;
            },
            {
              message: "User should be added to group",
              timeout: 60000, // 60 seconds
              intervals: [3000], // Check every 3 seconds
            },
          )
          .toContain("04kash");
      });

      test("Removing a user from a group", async ({ uiHelper }) => {
        await CustomAPIHelper.addUserToTeam(
          "janus-qe",
          teamName,
          "04kash",
          process.env.VAULT_GH_RHDH_QE_USER_TOKEN!,
        );
        userAddedToTeam = true;

        await githubEventsHelper.sendMembershipEvent(
          "added",
          "04kash",
          teamName,
          "janus-qe",
        );

        const api = new CustomAPIHelper();
        await api.useStaticToken(staticToken);
        await api.useBaseUrl(rhdhBaseUrl);

        await expect
          .poll(
            async () => {
              const groupEntity = await api.getGroupEntityFromAPI(teamName);
              const members =
                groupEntity.relations
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  ?.filter((r: any) => r.type === "hasMember")
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  .map((r: any) => r.targetRef.split("/")[1]) || [];
              return members;
            },
            {
              message: "User should be added to group before removal test",
              timeout: 60000,
              intervals: [3000],
            },
          )
          .toContain("04kash");

        await CustomAPIHelper.removeUserFromTeam(
          "janus-qe",
          teamName,
          "04kash",
          process.env.VAULT_GH_RHDH_QE_USER_TOKEN!,
        );
        userAddedToTeam = false;

        await githubEventsHelper.sendMembershipEvent(
          "removed",
          "04kash",
          teamName,
          "janus-qe",
        );

        await uiHelper.waitForLoad(10000);

        await expect
          .poll(
            async () => {
              const groupEntity = await api.getGroupEntityFromAPI(teamName);
              const members =
                groupEntity.relations
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  ?.filter((r: any) => r.type === "hasMember")
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  .map((r: any) => r.targetRef.split("/")[1]) || [];
              return members;
            },
            {
              message: "User should be removed from group",
              timeout: 60000,
              intervals: [3000],
            },
          )
          .not.toContain("04kash");
      });
    });
  });
});
