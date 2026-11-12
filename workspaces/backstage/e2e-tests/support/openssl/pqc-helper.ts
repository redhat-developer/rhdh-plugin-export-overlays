import path from "node:path";

import {
  $,
  KubernetesClientHelper,
  WorkspacePaths,
} from "@red-hat-developer-hub/e2e-test-utils/utils";

import {
  CONFIG_DIR,
  PQ_HTTPD_NAME,
  type TlsGroup,
} from "../../tests/config/openssl-pqc/fixture.js";
import {
  type OpensslSClientResult,
  runOpensslSClientFromRhdhPod,
} from "./s-client.js";

export type PQCDeploymentConfig = {
  namespace: string;
  releaseName: string;
  configDir: string;
};

/**
 * Deploys the PQC HTTPS peer (ubi10/httpd-24 + edge Route), OpenLDAP-style.
 * Call from test.runOnce — not globalSetup. Deploys into the Playwright project namespace.
 */
export class PQCHelper {
  k8sClient = new KubernetesClientHelper();
  deploymentConfig: PQCDeploymentConfig;
  routeUrl = "";
  routeHost = "";

  constructor(options: { releaseName?: string; configDir?: string } = {}) {
    this.deploymentConfig = {
      namespace: "",
      releaseName: options.releaseName ?? PQ_HTTPD_NAME,
      configDir: options.configDir ?? CONFIG_DIR,
    };
  }

  /**
   * Deploy httpd + edge Route into the given namespace and resolve the Route host.
   */
  async deploy(namespace: string): Promise<void> {
    this.deploymentConfig.namespace = namespace;
    this._log(`Starting PQC httpd deployment in ${namespace}...`);
    await this.k8sClient.createNamespaceIfNotExists(namespace);
    await this._applyManifests();
    await this.waitUntilReady();
    await this.resolveRoute();
    this._log(`PQC httpd ready at ${this.routeUrl}`);
  }

  /** Re-read the edge Route URL/host (safe after worker restart when deploy was skipped). */
  async resolveRoute(): Promise<void> {
    const { namespace, releaseName } = this.deploymentConfig;
    if (!namespace) {
      throw new Error(
        "PQC namespace is not set — call deploy(namespace) first",
      );
    }
    this.routeUrl = await this.k8sClient.getRouteLocation(
      namespace,
      releaseName,
    );
    this.routeHost = new URL(this.routeUrl).hostname;
  }

  getRouteHost(): string {
    if (!this.routeHost) {
      throw new Error(
        "PQC route host is not set — call deploy(namespace) or resolveRoute() first",
      );
    }
    return this.routeHost;
  }

  getRouteUrl(): string {
    if (!this.routeUrl) {
      throw new Error(
        "PQC route URL is not set — call deploy(namespace) or resolveRoute() first",
      );
    }
    return this.routeUrl;
  }

  async waitUntilReady(timeoutSeconds = 180): Promise<void> {
    const { namespace, releaseName } = this.deploymentConfig;
    this._log("Waiting for PQC httpd pods...");
    await this.k8sClient.waitForPodsWithFailureDetection(
      namespace,
      `app=${releaseName}`,
      timeoutSeconds,
    );
  }

  async teardown(): Promise<void> {
    const { namespace, releaseName } = this.deploymentConfig;
    this._log(`Tearing down PQC httpd ${releaseName} in ${namespace}...`);
    await $`kubectl delete deployment,svc,route -l app=${releaseName} -n ${namespace} --ignore-not-found=true`.nothrow();
  }

  /** openssl s_client from the RHDH hub pod against this helper's edge Route host. */
  runSClientFromRhdhPod(group: TlsGroup): OpensslSClientResult {
    return runOpensslSClientFromRhdhPod({
      namespace: this.deploymentConfig.namespace,
      host: this.getRouteHost(),
      group,
    });
  }

  private async _applyManifests(): Promise<void> {
    const { namespace, configDir } = this.deploymentConfig;
    const configBase = WorkspacePaths.resolve(configDir);
    await $`kubectl apply -f ${path.join(configBase, "httpd.yaml")} -n ${namespace}`;
    await $`kubectl apply -f ${path.join(configBase, "route.yaml")} -n ${namespace}`;
  }

  private _log(message: string): void {
    console.info(`[PQCHelper] ${message}`);
  }
}
