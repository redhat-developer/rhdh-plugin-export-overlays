import { expect, type Page } from "@playwright/test";
import type { RHDHDeployment } from "@red-hat-developer-hub/e2e-test-utils/rhdh";
import { LoginHelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";
import { test } from "@red-hat-developer-hub/e2e-test-utils/test";
import { $ } from "@red-hat-developer-hub/e2e-test-utils/utils";
import fs from "fs";
import yaml from "js-yaml";
import os from "os";
import path from "path";
import { openChatDrawer } from "./sidebar";

function isNightlyMode(): boolean {
  if (process.env.GIT_PR_NUMBER) {
    return false;
  }
  if (
    process.env.E2E_NIGHTLY_MODE === "true" ||
    process.env.E2E_NIGHTLY_MODE === "1"
  ) {
    return true;
  }
  return process.env.JOB_NAME?.includes("periodic-") ?? false;
}

function isMcpNightlyDisabled(): boolean {
  return (
    process.env.DISABLE_MCP_NIGHTLY === "true" ||
    process.env.DISABLE_MCP_NIGHTLY === "1"
  );
}

function dynamicPluginsFile(): string {
  if (isNightlyMode() && isMcpNightlyDisabled()) {
    return "tests/config/dynamic-plugins-nightly.yaml";
  }
  return "tests/config/dynamic-plugins-mcp.yaml";
}

function lightspeedDeployConfig() {
  return {
    auth: "keycloak" as const,
    version: process.env.RHDH_VERSION ?? "2.1",
    appConfig: "tests/config/app-config-rhdh.yaml",
    secrets: "tests/config/rhdh-secrets.yaml",
    valueFile: "tests/config/value_file.yaml",
    dynamicPlugins: dynamicPluginsFile(),
  };
}

type LightspeedStackConfig = {
  inference?: {
    providers?: Array<Record<string, unknown>>;
  };
};

/**
 * RHDH chart 2.1+ (intelligentAssistant) creates
 * `{release}-ia-stack` with data key `lightspeed-stack.yaml`.
 * Older chart 2.0 used `{release}-lightspeed-config` / `config.yaml`.
 */
async function patchOpenAiAllowedModels(rhdh: RHDHDeployment): Promise<void> {
  const ns = rhdh.deploymentConfig.namespace;
  const cm = "redhat-developer-hub-ia-stack";
  const dataKey = "lightspeed-stack.yaml";
  const models = yaml.load(
    fs.readFileSync("tests/config/openai-allowed-models.yaml", "utf8"),
  ) as Record<string, string[]>;
  const allowedModels = models.allowed_models;

  const result = await $({
    stdio: ["pipe", "pipe", "pipe"],
  })`oc get configmap ${cm} -n ${ns} -o json`;
  const configYaml = (
    JSON.parse(result.stdout) as { data?: Record<string, string> }
  ).data?.[dataKey];
  if (!configYaml) {
    throw new Error(`ConfigMap ${cm} has no ${dataKey} data key`);
  }
  const config = yaml.load(configYaml) as LightspeedStackConfig;
  if (!config.inference) {
    config.inference = {};
  }
  if (!config.inference.providers) {
    config.inference.providers = [];
  }
  const providers = config.inference.providers;

  // Chart-bundled stack comments out openai; ensure a live provider for e2e.
  // LCORE YAML keys are snake_case (api_key_env, allowed_models).
  let openai = providers.find((p) => p.type === "openai");
  if (!openai) {
    openai = {
      type: "openai",
      id: "openai",
      ["api_key_env"]: "OPENAI_API_KEY",
      extra: { ["allowed_models"]: allowedModels },
    };
    providers.push(openai);
  } else {
    const extra = (openai.extra ?? {}) as Record<string, unknown>;
    if (
      JSON.stringify(extra["allowed_models"]) === JSON.stringify(allowedModels)
    ) {
      return;
    }
    openai.extra = { ...extra, ["allowed_models"]: allowedModels };
  }

  const tmp = path.join(os.tmpdir(), `${ns}-lightspeed-stack.yaml`);
  fs.writeFileSync(tmp, yaml.dump(config));
  await rhdh.k8sClient.createOrUpdateConfigMap(cm, ns, tmp, dataKey);
  await $`oc rollout restart deployment/redhat-developer-hub -n ${ns}`;
  // waitUntilReady() is true while old+new hub pods are both Ready (plus Postgres),
  // which races Keycloak sessions across pods (in-memory session store). Gate on
  // rollout completion and Ready backstage pods before login/tests.
  // lightspeed-core EmptyDir vector stores are also orphaned by a mid-suite swap.
  await $`oc rollout status deployment/redhat-developer-hub -n ${ns} --timeout=300s`;
  await $`oc wait --for=condition=Ready pod -l app.kubernetes.io/component=backstage -n ${ns} --timeout=300s`;
  await rhdh.waitUntilReady();
}

async function isSignInPage(page: Page): Promise<boolean> {
  return page
    .getByRole("heading", { name: "Select a sign-in method" })
    .isVisible();
}

async function isLoggedIn(page: Page): Promise<boolean> {
  return page
    .getByRole("navigation", { name: "sidebar nav" })
    .or(page.getByRole("button", { name: "Settings" }))
    .first()
    .isVisible();
}

async function waitForAuthSettled(page: Page, timeout = 60_000): Promise<void> {
  await page
    .getByRole("heading", { name: "Select a sign-in method" })
    .or(page.getByRole("navigation", { name: "sidebar nav" }))
    .or(page.getByRole("button", { name: "Settings" }))
    .first()
    .waitFor({ state: "visible", timeout });
}

async function waitForLoggedInChrome(
  page: Page,
  timeout = 60_000,
): Promise<void> {
  await expect(
    page
      .getByRole("navigation", { name: "sidebar nav" })
      .or(page.getByRole("button", { name: "Settings" }))
      .first(),
  ).toBeVisible({ timeout });
}

async function fillKeycloakFormIfPresent(
  page: Page,
  userid: string,
  password: string,
): Promise<void> {
  const username = page.locator("#username");
  if (!(await username.isVisible())) {
    return;
  }
  await username.fill(userid);
  await page.locator("#password").fill(password);
  await page.locator("#kc-login").click();
}

/**
 * Re-auth when navigation lands on OIDC Sign In (in-memory hub sessions).
 *
 * Do not use LoginHelper.loginAsKeycloakUser here: it always goto("/") and
 * only waits for a Keycloak popup. Mid-suite Sign In often completes in-page
 * via SSO (no popup), which hangs that helper and leaves the suite on Home
 * with IA closed.
 */
export async function ensureKeycloakSession(page: Page): Promise<void> {
  await waitForAuthSettled(page);
  if (!(await isSignInPage(page))) {
    return;
  }

  const login = new LoginHelper(page);
  const signInMethod = page.getByRole("heading", {
    name: "Select a sign-in method",
  });
  const keycloakProviderBtn = page.getByRole("button", {
    name: /sign in using keycloak/i,
  });
  const signInBtn = page.getByRole("button", { name: "Sign In" });
  const userid = process.env.TEST_USERNAME ?? "test1";
  const password = process.env.TEST_PASSWORD ?? "test1@123";

  const popupPromise = page
    .waitForEvent("popup", { timeout: 20_000 })
    .then((popup) => ({ type: "popup" as const, popup }))
    .catch(() => null);
  const ssoPromise = Promise.race([
    signInMethod
      .waitFor({ state: "hidden", timeout: 20_000 })
      .then(() => ({ type: "sso" as const })),
    page
      .getByRole("navigation", { name: "sidebar nav" })
      .waitFor({ state: "visible", timeout: 20_000 })
      .then(() => ({ type: "sso" as const })),
  ]).catch(() => null);

  if (await keycloakProviderBtn.isVisible()) {
    await keycloakProviderBtn.click();
  } else {
    await signInBtn.click();
  }

  const result = await Promise.race([popupPromise, ssoPromise]);
  if (result === null) {
    throw new Error(
      "Keycloak re-login failed: neither sidebar nor popup appeared after Sign In",
    );
  }
  if (result.type === "popup") {
    await login.logintoKeycloak(result.popup, userid, password);
  } else {
    await fillKeycloakFormIfPresent(page, userid, password);
  }
  await waitForLoggedInChrome(page);
  await expect(
    page.getByRole("heading", { name: "Select a sign-in method" }),
  ).toBeHidden();
}

/** Navigate to /catalog; prefer sidebar link when already authenticated. */
export async function gotoCatalogAuthenticated(page: Page): Promise<void> {
  if (
    /\/catalog/.test(page.url()) &&
    (await isLoggedIn(page)) &&
    !(await isSignInPage(page))
  ) {
    return;
  }

  if ((await isLoggedIn(page)) && !(await isSignInPage(page))) {
    const catalogLink = page
      .getByRole("navigation", { name: "sidebar nav" })
      .getByRole("link", { name: "Catalog", exact: true });
    if (await catalogLink.isVisible()) {
      await catalogLink.click();
      await expect(page).toHaveURL(/\/catalog/, { timeout: 30_000 });
      return;
    }
  }

  await page.goto("/catalog");
  await ensureKeycloakSession(page);
  if (!/\/catalog/.test(page.url())) {
    await page.goto("/catalog");
    await ensureKeycloakSession(page);
  }
}

export async function ensureLightspeedDeployment(
  rhdh: RHDHDeployment,
): Promise<void> {
  const ns = rhdh.deploymentConfig.namespace;
  await test.runOnce(`intelligent-assistant-deploy-${ns}`, async () => {
    await rhdh.configure(lightspeedDeployConfig());

    // e2e-test-utils scaleDownAndRestart breaks on helm upgrade (label selector + bash).
    try {
      await $`oc get deployment redhat-developer-hub -n ${ns}`;
      await $`oc delete deployment redhat-developer-hub -n ${ns} --wait=true`;
    } catch {
      /* fresh install */
    }

    // A transient lightspeed-core ErrImagePull fails the whole serial file.
    // The next suite already recovers by deleting the deployment and deploying again.
    try {
      await rhdh.deploy();
    } catch (error) {
      console.warn(
        `RHDH deploy failed (${error instanceof Error ? error.message : String(error)}); retrying once`,
      );
      try {
        await $`oc delete deployment redhat-developer-hub -n ${ns} --wait=true`;
      } catch {
        /* deployment may already be gone */
      }
      await rhdh.deploy();
    }
    await patchOpenAiAllowedModels(rhdh);
  });
}

/** Opens /intelligent-assistant and waits for the IA chat shell. */
export async function openLightspeed(page: Page): Promise<void> {
  const chatUi = page
    .locator(".pf-chatbot__messagebox")
    .or(page.getByRole("heading", { name: "Intelligent assistant" }))
    .or(
      page.getByRole("heading", {
        name: "Developer Hub Intelligent Assistant",
      }),
    )
    .or(page.getByTestId("lightspeed-lcore-not-configured"));

  if (
    /\/intelligent-assistant/.test(page.url()) &&
    (await isLoggedIn(page)) &&
    !(await isSignInPage(page)) &&
    (await chatUi.first().isVisible())
  ) {
    return;
  }

  await page.goto("/intelligent-assistant", { waitUntil: "domcontentloaded" });
  await ensureKeycloakSession(page);

  if (
    !/\/intelligent-assistant/.test(page.url()) ||
    (await isSignInPage(page))
  ) {
    await page.goto("/intelligent-assistant", {
      waitUntil: "domcontentloaded",
    });
    await ensureKeycloakSession(page);
  }

  await expect(
    page.getByRole("heading", { name: "Select a sign-in method" }),
  ).toBeHidden({ timeout: 60_000 });
  await expect(page).toHaveURL(/\/intelligent-assistant/, { timeout: 60_000 });
  await chatUi.first().waitFor({ state: "visible", timeout: 120_000 });
}

/** Reload IA and recover Keycloak session (in-memory hub sessions). */
export async function reloadLightspeedAuthenticated(page: Page): Promise<void> {
  await page.reload({ waitUntil: "domcontentloaded" });
  await ensureKeycloakSession(page);
  await openLightspeed(page);
  const drawerOpen = page.getByRole("button", { name: "Close drawer panel" });
  if (!(await drawerOpen.isVisible())) {
    await openChatDrawer(page);
  }
}
