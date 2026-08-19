import { defineConfig } from "@red-hat-developer-hub/e2e-test-utils/playwright-config";

/**
 * Roadie plugins e2e test configuration.
 *
 * There is deliberately no `-app-next` project here. Both lanes are blocked upstream,
 * for two different reasons, and both were verified at the ref this workspace pins
 * (`source.json` → RoadieHQ/roadie-backstage-plugins@c1b84e94) as well as on upstream
 * `main`, 62 commits ahead, where the relevant file is unchanged:
 *
 * 1. `backstage-plugin-github-pull-requests` — the package does have an NFS surface
 *    (`src/alpha.tsx`, `createFrontendPlugin`), but it registers
 *    `extensions: [githubPullRequestsApi]` — an `ApiBlueprint` and nothing else. No
 *    `EntityContentBlueprint`, so the "Pull/Merge Requests" entity tab this spec clicks
 *    cannot exist under the new frontend system. The NFS surface contributes an API, no
 *    UI. The package also declares no `backstage.features` and has no `exports` map.
 *
 * 2. `scaffolder-backend-module-http-request` — a backend module, so NFS does not apply
 *    to it at all. Its spec asserts `verifyHeading("Self-service")`, which is a global
 *    header element, and `rhdh:packages/app-next` ships no global header.
 *
 * Adding a lane would produce a suite that fails on a missing tab, and the failure would
 * read as a wiring bug rather than as the absence of an upstream extension. Per the
 * support-level rules in rhdh:docs/testing-requirements-matrix.md these packages are
 * `community`, which requires no E2E at all — so the fix is upstream contribution or
 * nothing, not a lane here.
 *
 * Tracked in RHIDP-16301.
 */
export default defineConfig({
  projects: [
    {
      name: "backstage-plugin-github-pull-requests",
      testMatch:
        /tests\/specs\/backstage-plugin-github-pull-requests\.spec\.ts/,
    },
    {
      name: "scaffolder-backend-module-http-request",
      testMatch:
        /tests\/specs\/scaffolder-backend-module-http-request\.spec\.ts/,
    },
  ],
});
