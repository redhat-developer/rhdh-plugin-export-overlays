import { test, expect, request } from "rhdh-e2e-test-utils/test";
import { CustomAPIHelper } from "../../support/api/api-helper";
import { GitHubEventsHelper } from "../../support/api/github-events";
import { createHmac } from "crypto";

test.describe("GitHub Events Module", () => {
  let githubEventsHelper: GitHubEventsHelper;
  let staticToken: string;
  let rhdhBaseUrl: string;

  test.beforeAll(async ({ rhdh }) => {
    // Configure RHDH with Guest authentication
    await rhdh.configure({ auth: "guest" });

    // Deploy RHDH instance
    await rhdh.deploy();

    // Get the guest token from RHDH auth endpoint
    const authResponse = await fetch(`${rhdh.rhdhUrl}/api/auth/guest/refresh`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
    });

    if (!authResponse.ok) {
      throw new Error(`Failed to get guest token: ${authResponse.status}`);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const authData = (await authResponse.json()) as any;
    staticToken = authData.backstageIdentity?.token || authData.token;

    if (!staticToken) {
      throw new Error(
        "No token found in auth response: " + JSON.stringify(authData),
      );
    }
    // Initialize GitHub events helper
    githubEventsHelper = await GitHubEventsHelper.build(
      rhdh.rhdhUrl,
      process.env.ORG_WEBHOOK_SECRET!,
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

    const secret = process.env.ORG_WEBHOOK_SECRET!;
    const signature =
      "sha256=" +
      createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");

    const context = await request.newContext();

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
  });

  test.describe("GitHub Discovery", () => {
    const catalogRepoName = `janus-test-github-events-test-${Date.now()}`;
    const catalogRepoDetails = {
      name: catalogRepoName,
      url: `github.com/04kash-test-org/${catalogRepoName}`,
      org: `github.com/04kash-test-org`,
      owner: "04kash-test-org",
    };

    test("Adding a new entity to the catalog", async ({ page, uiHelper }) => {
      const catalogInfoYamlContent = `apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: ${catalogRepoName}
  annotations:
    github.com/project-slug: 04kash-test-org/${catalogRepoName}
  description: E2E test component for github events module
spec:
  type: other
  lifecycle: unknown
  owner: user:default/04kash`;

      await CustomAPIHelper.createGitHubRepoWithFile(
        catalogRepoDetails.owner,
        catalogRepoDetails.name,
        "catalog-info.yaml",
        catalogInfoYamlContent,
      );

      await githubEventsHelper.sendPushEvent(
        `04kash-test-org/${catalogRepoName}`,
        "added",
      );

      await uiHelper.waitForLoad(10000);
      await page.reload();
      await uiHelper.waitForLoad(10000);
      await uiHelper.openSidebar("Catalog");
      await uiHelper.selectMuiBox("Kind", "Component");

      await uiHelper.searchInputPlaceholder(catalogRepoName);
      await expect(
        page.getByRole("link", { name: catalogRepoName }),
      ).toBeVisible({
        timeout: 15000,
      });
    });

    test("Updating an entity in the catalog", async ({ page, uiHelper }) => {
      const updatedDescription = "updated description";
      const updatedCatalogInfoYaml = `apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: ${catalogRepoName}
  annotations:
    github.com/project-slug: 04kash-test-org/${catalogRepoName}
  description: ${updatedDescription}
spec:
  type: other
  lifecycle: unknown
  owner: user:default/04kash-test-user`;
      await CustomAPIHelper.updateFileInRepo(
        catalogRepoDetails.owner,
        catalogRepoDetails.name,
        "catalog-info.yaml",
        updatedCatalogInfoYaml,
        "Update catalog-info.yaml description",
      );
      await githubEventsHelper.sendPushEvent(
        `04kash-test-org/${catalogRepoName}`,
        "modified",
      );
      await uiHelper.waitForLoad(10000);
      await page.reload();
      await uiHelper.waitForLoad(10000);
      await uiHelper.openSidebar("Catalog");
      await uiHelper.selectMuiBox("Kind", "Component");

      await uiHelper.searchInputPlaceholder(catalogRepoName);
      await page.getByRole("link", { name: catalogRepoName }).click();
      await expect(page.getByText(updatedDescription)).toBeVisible({
        timeout: 15000,
      });
    });

    test("Deleting an entity from the catalog", async ({ page, uiHelper }) => {
      await CustomAPIHelper.deleteFileInRepo(
        catalogRepoDetails.owner,
        catalogRepoDetails.name,
        "catalog-info.yaml",
        "Remove catalog-info.yaml",
      );
      await githubEventsHelper.sendPushEvent(
        `04kash-test-org/${catalogRepoName}`,
        "removed",
      );
      await uiHelper.waitForLoad(10000);
      await page.reload();
      await uiHelper.waitForLoad(10000);
      await uiHelper.openSidebar("Catalog");
      await uiHelper.selectMuiBox("Kind", "Component");

      await uiHelper.searchInputPlaceholder(catalogRepoName);
      await expect(
        page.getByRole("link", { name: catalogRepoName }),
      ).not.toBeVisible({
        timeout: 15000,
      });
    });
  });

  test.describe("GitHub Organizational Data", () => {
    // eslint-disable-next-line playwright/max-nested-describe
    test.describe("Teams", () => {
      const teamName = "test-team-" + Date.now();

      test("Adding a new group", async ({ page, uiHelper }) => {
        await CustomAPIHelper.createTeamInOrg("04kash-test-org", teamName);
        await githubEventsHelper.sendTeamEvent(
          "created",
          teamName,
          "04kash-test-org",
        );

        await uiHelper.waitForLoad(10000);
        await uiHelper.openSidebar("Catalog");
        await uiHelper.selectMuiBox("Kind", "Group");
        await uiHelper.searchInputPlaceholder(teamName);

        await expect(page.getByRole("link", { name: teamName })).toBeVisible({
          timeout: 15000,
        });
      });

      test("Deleting a group", async ({ page, uiHelper }) => {
        await CustomAPIHelper.deleteTeamFromOrg("04kash-test-org", teamName);

        await githubEventsHelper.sendTeamEvent(
          "deleted",
          teamName,
          "04kash-test-org",
        );
        await uiHelper.waitForLoad(10000);
        await page.reload();
        await uiHelper.waitForLoad(10000);
        await uiHelper.openSidebar("Catalog");
        await uiHelper.selectMuiBox("Kind", "Group");
        await uiHelper.searchInputPlaceholder(teamName);

        await expect(
          page.getByRole("link", { name: teamName }),
        ).not.toBeVisible({
          timeout: 15000,
        });
      });
    });

    // eslint-disable-next-line playwright/max-nested-describe
    test.describe("Team Membership", () => {
      let teamCreated = false;
      let userAddedToTeam = false;
      let teamName: string;

      test.beforeEach(async () => {
        // Generate unique team name for each test
        teamName = "test-team-" + Date.now();

        // Create team in GitHub
        await CustomAPIHelper.createTeamInOrg("04kash-test-org", teamName);
        teamCreated = true;

        // Send team creation webhook to RHDH
        await githubEventsHelper.sendTeamEvent(
          "created",
          teamName,
          "04kash-test-org",
        );

        // Wait for RHDH to process team creation
        await new Promise((resolve) => setTimeout(resolve, 2000));
      });

      test.afterEach(async () => {
        if (userAddedToTeam) {
          await CustomAPIHelper.removeUserFromTeam(
            "04kash-test-org",
            teamName,
            process.env.TEST_GITHUB_USER!,
          );
          userAddedToTeam = false;
        }

        if (teamCreated) {
          await CustomAPIHelper.deleteTeamFromOrg("04kash-test-org", teamName);
          teamCreated = false;
        }
      });

      test("Adding a user to a group", async ({ uiHelper }) => {
        // Step 1: Add user to team in GitHub
        await CustomAPIHelper.addUserToTeam(
          "04kash-test-org",
          teamName,
          process.env.TEST_GITHUB_USER!,
        );
        userAddedToTeam = true;

        // Step 2: Send membership "added" webhook to RHDH
        await githubEventsHelper.sendMembershipEvent(
          "added",
          process.env.TEST_GITHUB_USER!,
          teamName,
          "04kash-test-org",
        );

        await uiHelper.waitForLoad(10000);

        // Step 3: Verify user is in the group (with polling)
        const api = new CustomAPIHelper();
        await api.useStaticToken(staticToken);
        await api.useBaseUrl(rhdhBaseUrl);

        // Use expect.poll() to retry the API call
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
          .toContain(process.env.TEST_GITHUB_USER!);
      });

      test("Removing a user from a group", async ({ uiHelper }) => {
        // Setup: Add user first
        await CustomAPIHelper.addUserToTeam(
          "04kash-test-org",
          teamName,
          process.env.TEST_GITHUB_USER!,
        );
        userAddedToTeam = true;

        // Send "added" webhook to sync initial state
        await githubEventsHelper.sendMembershipEvent(
          "added",
          process.env.TEST_GITHUB_USER!,
          teamName,
          "04kash-test-org",
        );

        const api = new CustomAPIHelper();
        await api.useStaticToken(staticToken);
        await api.useBaseUrl(rhdhBaseUrl);

        // Wait for user to be added first (with polling)
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
          .toContain(process.env.TEST_GITHUB_USER!);

        // Step 1: Remove user from the team in GitHub
        await CustomAPIHelper.removeUserFromTeam(
          "04kash-test-org",
          teamName,
          process.env.TEST_GITHUB_USER!,
        );
        userAddedToTeam = false;

        // Step 2: Send membership "removed" webhook to RHDH
        await githubEventsHelper.sendMembershipEvent(
          "removed",
          process.env.TEST_GITHUB_USER!,
          teamName,
          "04kash-test-org",
        );

        await uiHelper.waitForLoad(10000);

        // Step 3: Verify user is NOT in the group (with polling)
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
          .not.toContain(process.env.TEST_GITHUB_USER!);
      });
    });
  });
});
