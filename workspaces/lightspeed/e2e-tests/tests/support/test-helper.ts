import { expect, type Page } from "@playwright/test";
import type { RHDHDeployment } from "@red-hat-developer-hub/e2e-test-utils/rhdh";
import { test } from "@red-hat-developer-hub/e2e-test-utils/test";
import { $ } from "@red-hat-developer-hub/e2e-test-utils/utils";
import fs from "fs";
import yaml from "js-yaml";
import os from "os";
import path from "path";

/** Single namespace for all Lightspeed Playwright projects (see playwright.config.ts). */
export const lightspeedNamespace = process.env.RHDH_NAMESPACE ?? "lightspeed";

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

export const lightspeedDeployConfig = {
  auth: "keycloak" as const,
  version: process.env.RHDH_VERSION ?? "1.11",
  namespace: lightspeedNamespace,
  appConfig: "tests/config/app-config-rhdh.yaml",
  secrets: "tests/config/rhdh-secrets.yaml",
  valueFile: "tests/config/value_file.yaml",
  ...(isNightlyMode()
    ? { dynamicPlugins: "tests/config/dynamic-plugins-nightly.yaml" }
    : {}),
};

async function patchOpenAiAllowedModels(rhdh: RHDHDeployment): Promise<void> {
  const ns = rhdh.deploymentConfig.namespace;
  const cm = "redhat-developer-hub-lightspeed-config";
  const models = yaml.load(
    fs.readFileSync("tests/config/openai-allowed-models.yaml", "utf8"),
  ) as Record<string, string[]>;
  const allowedModels = models.allowed_models;

  const result = await $({
    stdio: ["pipe", "pipe", "pipe"],
  })`oc get configmap ${cm} -n ${ns} -o json`;
  const configYaml = (
    JSON.parse(result.stdout) as { data?: Record<string, string> }
  ).data?.["config.yaml"];
  if (!configYaml) {
    throw new Error(`ConfigMap ${cm} has no config.yaml data key`);
  }
  const config = yaml.load(configYaml) as {
    providers?: { inference?: Record<string, unknown>[] };
  };
  const inference = config.providers?.inference;
  if (!inference) {
    throw new Error(`ConfigMap ${cm} config.yaml has no providers.inference`);
  }
  const openai = inference.find((p) => p.provider_type === "remote::openai") as
    | { config: Record<string, unknown> }
    | undefined;
  if (!openai)
    throw new Error("OpenAI provider not found in lightspeed config");
  if (
    JSON.stringify(openai.config.allowed_models) ===
    JSON.stringify(allowedModels)
  ) {
    return;
  }

  openai.config.allowed_models = allowedModels;
  const tmp = path.join(os.tmpdir(), `${ns}-llama-stack-config.yaml`);
  fs.writeFileSync(tmp, yaml.dump(config));
  await rhdh.k8sClient.createOrUpdateConfigMap(cm, ns, tmp, "config.yaml");
  await $`oc rollout restart deployment/redhat-developer-hub -n ${ns}`;
  await rhdh.waitUntilReady();
}

export async function ensureLightspeedDeployment(
  rhdh: RHDHDeployment,
): Promise<void> {
  await test.runOnce(`lightspeed-deploy-${lightspeedNamespace}`, async () => {
    await rhdh.configure(lightspeedDeployConfig);

    // e2e-test-utils scaleDownAndRestart breaks on helm upgrade (label selector + bash).
    const ns = rhdh.deploymentConfig.namespace;
    try {
      await $`oc get deployment redhat-developer-hub -n ${ns}`;
      await $`oc delete deployment redhat-developer-hub -n ${ns} --wait=true`;
    } catch {
      /* fresh install */
    }

    await rhdh.deploy();
    await patchOpenAiAllowedModels(rhdh);
  });
}

/** Opens /lightspeed and waits for any recognizable Lightspeed shell (chat, heading, or empty state). */
export async function openLightspeed(page: Page): Promise<void> {
  await page.goto("/lightspeed", { waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(/\/lightspeed/, { timeout: 60_000 });

  const chatUi = page
    .locator(".pf-chatbot__messagebox")
    .or(page.getByRole("heading", { name: "Developer Lightspeed" }))
    .or(page.getByTestId("lightspeed-lcore-not-configured"));

  await chatUi.first().waitFor({ state: "visible", timeout: 120_000 });
}
