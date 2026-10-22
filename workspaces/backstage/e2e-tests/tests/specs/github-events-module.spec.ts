import {
  expect,
  request,
  test,
} from "@red-hat-developer-hub/e2e-test-utils/test";
import {
  CatalogApiHelper,
  getSessionAuthToken,
} from "@red-hat-developer-hub/e2e-test-utils/helpers";
import { requireEnv } from "@red-hat-developer-hub/e2e-test-utils/utils";
import { createHmac } from "node:crypto";
import { GitHubEventsHelper } from "../../support/api/github-events";
import { GitHubApiHelper } from "../../support/api/github-api-helper";

test.describe("GitHub Events Module", () => {
  let githubEventsHelper: GitHubEventsHelper;
  let staticToken: string;
  let rhdhBaseUrl: string;

  test.beforeAll(async ({ rhdh }) => {
    requireEnv("VAULT_GITHUB_APP_WEBHOOK_SECRET");

    await rhdh.configure({
      auth: "keycloak",
      appConfig: "tests/config/github-events/app-config-rhdh.yaml",
      secrets: "tests/config/github-events/rhdh-secrets.yaml",
      dynamicPlugins: "tests/config/github-events/dynamic-plugins.yaml",
    });

    await rhdh.deploy();

    githubEventsHelper = await GitHubEventsHelper.build(
      rhdh.rhdhUrl,
      process.env.VAULT_GITHUB_APP_WEBHOOK_SECRET!,
    );
    rhdhBaseUrl = rhdh.rhdhUrl;
  });

  test.beforeEach(async ({ loginHelper }) => {
    await loginHelper.loginAsKeycloakUser();
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

  test.describe.serial("GitHub Discovery", () => {
    // run-e2e.sh uses baseConfig (90s default); catalog ingest can exceed that.
    test.describe.configure({ timeout: 180_000 });

    const catalogRepoName = `janus-test-github-events-test-${Date.now()}`;
    const catalogRepoDetails = {
      name: catalogRepoName,
      url: `github.com/janus-qe/${catalogRepoName}`,
      org: `github.com/janus-qe`,
      owner: "janus-qe",
    };
    let discoveryToken: string;

    test.beforeEach(async ({ page, uiHelper }) => {
      if (!discoveryToken) {
        discoveryToken = await getSessionAuthToken(page, uiHelper, rhdhBaseUrl);
      }
    });

    test("Adding a new entity to the catalog", async () => {
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

      await GitHubApiHelper.createGitHubRepoWithFile(
        catalogRepoDetails.owner,
        catalogRepoDetails.name,
        "catalog-info.yaml",
        catalogInfoYamlContent,
      );

      const pushResponse = await githubEventsHelper.sendPushEvent(
        `janus-qe/${catalogRepoName}`,
        "added",
      );
      expect(pushResponse.ok()).toBeTruthy();

      await expect
        .poll(
          () =>
            CatalogApiHelper.entityExists(
              rhdhBaseUrl,
              discoveryToken,
              "component",
              catalogRepoName,
            ),
          {
            message: `Component ${catalogRepoName} should appear in catalog`,
            timeout: 150_000,
            intervals: [3_000],
          },
        )
        .toBe(true);
    });

    test("Updating an entity in the catalog", async () => {
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
      await GitHubApiHelper.updateFileInRepo(
        catalogRepoDetails.owner,
        catalogRepoDetails.name,
        "catalog-info.yaml",
        updatedCatalogInfoYaml,
        "Update catalog-info.yaml description",
      );
      const pushResponse = await githubEventsHelper.sendPushEvent(
        `janus-qe/${catalogRepoName}`,
        "modified",
      );
      expect(pushResponse.ok()).toBeTruthy();

      await expect
        .poll(
          async () => {
            try {
              const description = await CatalogApiHelper.getEntityDescription(
                rhdhBaseUrl,
                discoveryToken,
                "component",
                catalogRepoName,
              );
              return description === updatedDescription;
            } catch {
              return false;
            }
          },
          {
            message: `Component ${catalogRepoName} should be updated with new description`,
            timeout: 150_000,
            intervals: [3_000],
          },
        )
        .toBe(true);
    });

    test("Deleting an entity from the catalog", async () => {
      await GitHubApiHelper.deleteFileInRepo(
        catalogRepoDetails.owner,
        catalogRepoDetails.name,
        "catalog-info.yaml",
        "Remove catalog-info.yaml",
      );
      const pushResponse = await githubEventsHelper.sendPushEvent(
        `janus-qe/${catalogRepoName}`,
        "removed",
      );
      expect(pushResponse.ok()).toBeTruthy();

      await expect
        .poll(
          () =>
            CatalogApiHelper.entityExists(
              rhdhBaseUrl,
              discoveryToken,
              "component",
              catalogRepoName,
            ),
          {
            message: `Component ${catalogRepoName} should be removed from catalog`,
            timeout: 150_000,
            intervals: [3_000],
          },
        )
        .toBe(false);
    });

    test.afterAll(async () => {
      await GitHubApiHelper.deleteGitHubRepo(
        catalogRepoDetails.owner,
        catalogRepoDetails.name,
      );
    });
  });

  test.describe("GitHub Organizational Data", () => {
    // eslint-disable-next-line playwright/max-nested-describe
    test.describe.serial("Teams", () => {
      const teamName = "test-team-" + Date.now();

      test.beforeEach(async ({ page, uiHelper }) => {
        if (!staticToken) {
          staticToken = await getSessionAuthToken(page, uiHelper, rhdhBaseUrl);
        }
      });

      test("Adding a new group", async () => {
        await GitHubApiHelper.createTeamInOrg("janus-qe", teamName);
        await githubEventsHelper.sendTeamEvent("created", teamName, "janus-qe");

        await expect
          .poll(
            async () =>
              await CatalogApiHelper.entityExists(
                rhdhBaseUrl,
                staticToken,
                "Group",
                teamName,
              ),
            {
              message: `Team ${teamName} should appear in catalog`,
              timeout: 120_000,
              intervals: [3_000],
            },
          )
          .toBe(true);

        const entity = await CatalogApiHelper.getEntity(
          rhdhBaseUrl,
          staticToken,
          "Group",
          teamName,
        );
        expect(entity.metadata.name).toBe(teamName);
      });

      test("Deleting a group", async () => {
        await GitHubApiHelper.deleteTeamFromOrg("janus-qe", teamName);

        await githubEventsHelper.sendTeamEvent("deleted", teamName, "janus-qe");

        await expect
          .poll(
            async () =>
              !(await CatalogApiHelper.entityExists(
                rhdhBaseUrl,
                staticToken,
                "Group",
                teamName,
              )),
            {
              message: `Team ${teamName} should be removed from catalog`,
              timeout: 120_000,
              intervals: [3_000],
            },
          )
          .toBe(true);

        expect(
          await CatalogApiHelper.entityExists(
            rhdhBaseUrl,
            staticToken,
            "Group",
            teamName,
          ),
        ).toBe(false);
      });
    });

    // eslint-disable-next-line playwright/max-nested-describe
    test.describe("Team Membership", () => {
      let teamCreated = false;
      let userAddedToTeam = false;
      let teamName: string;

      test.beforeEach(async ({ page, uiHelper }) => {
        if (!staticToken) {
          staticToken = await getSessionAuthToken(page, uiHelper, rhdhBaseUrl);
        }

        teamName = "test-team-" + Date.now();

        await GitHubApiHelper.createTeamInOrg("janus-qe", teamName);
        teamCreated = true;

        await githubEventsHelper.sendTeamEvent("created", teamName, "janus-qe");

        await new Promise((resolve) => setTimeout(resolve, 2000));
      });

      test.afterEach(async () => {
        if (userAddedToTeam) {
          await GitHubApiHelper.removeUserFromTeam(
            "janus-qe",
            teamName,
            "rhdh-qe",
          );
          userAddedToTeam = false;
        }

        if (teamCreated) {
          await GitHubApiHelper.deleteTeamFromOrg("janus-qe", teamName);
          teamCreated = false;
        }
      });

      test("Adding a user to a group", async ({ uiHelper }) => {
        await GitHubApiHelper.addUserToTeam("janus-qe", teamName, "rhdh-qe");
        userAddedToTeam = true;

        await githubEventsHelper.sendMembershipEvent(
          "added",
          "rhdh-qe",
          teamName,
          "janus-qe",
        );

        await uiHelper.waitForLoad(10_000);

        await expect
          .poll(
            () =>
              CatalogApiHelper.getGroupMembers(
                rhdhBaseUrl,
                staticToken,
                teamName,
              ),
            {
              message: "User should be added to group",
              timeout: 60000,
              intervals: [3000],
            },
          )
          .toContain("rhdh-qe");
      });

      test("Removing a user from a group", async ({ uiHelper }) => {
        await GitHubApiHelper.addUserToTeam("janus-qe", teamName, "rhdh-qe");
        userAddedToTeam = true;

        await githubEventsHelper.sendMembershipEvent(
          "added",
          "rhdh-qe",
          teamName,
          "janus-qe",
        );

        await expect
          .poll(
            () =>
              CatalogApiHelper.getGroupMembers(
                rhdhBaseUrl,
                staticToken,
                teamName,
              ),
            {
              message: "User should be added to group before removal test",
              timeout: 60000,
              intervals: [3000],
            },
          )
          .toContain("rhdh-qe");

        await GitHubApiHelper.removeUserFromTeam(
          "janus-qe",
          teamName,
          "rhdh-qe",
        );
        userAddedToTeam = false;

        await githubEventsHelper.sendMembershipEvent(
          "removed",
          "rhdh-qe",
          teamName,
          "janus-qe",
        );

        await uiHelper.waitForLoad(10_000);

        await expect
          .poll(
            () =>
              CatalogApiHelper.getGroupMembers(
                rhdhBaseUrl,
                staticToken,
                teamName,
              ),
            {
              message: "User should be removed from group",
              timeout: 60000,
              intervals: [3000],
            },
          )
          .not.toContain("rhdh-qe");
      });
    });
  });
});
