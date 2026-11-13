import path from "node:path";

import {
  $,
  KubernetesClientHelper,
  WorkspacePaths,
} from "@red-hat-developer-hub/e2e-test-utils/utils";

import {
  CONFIG_DIR,
  PQ_HTTPD_HTTPS_PORT,
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
 * Deploys the PQC HTTPS peer (ubi10/httpd-24 with in-pod TLS on 8443).
 * Call from test.runOnce — not globalSetup. Deploys into the Playwright project namespace.
 */
export class PQCHelper {
  k8sClient = new KubernetesClientHelper();
  deploymentConfig: PQCDeploymentConfig;
  serviceHost = "";
  servicePort = PQ_HTTPD_HTTPS_PORT;

  constructor(options: { releaseName?: string; configDir?: string } = {}) {
    this.deploymentConfig = {
      namespace: "",
      releaseName: options.releaseName ?? PQ_HTTPD_NAME,
      configDir: options.configDir ?? CONFIG_DIR,
    };
  }

  /**
   * Deploy httpd + Service into the given namespace and resolve the Service host.
   */
  async deploy(namespace: string): Promise<void> {
    this.deploymentConfig.namespace = namespace;
    this._log(`Starting PQC httpd deployment in ${namespace}...`);
    await this.k8sClient.createNamespaceIfNotExists(namespace);
    await this._applyManifests();
    await this.waitUntilReady();
    this.resolveService();
    this._log(
      `PQC httpd ready at https://${this.serviceHost}:${this.servicePort}`,
    );
  }

  /**
   * Set the in-cluster Service DNS host (safe after worker restart when deploy
   * was skipped). Deterministic — no API lookup required.
   */
  resolveService(): void {
    const { namespace, releaseName } = this.deploymentConfig;
    if (!namespace) {
      throw new Error(
        "PQC namespace is not set — call deploy(namespace) first",
      );
    }
    // Same-namespace short FQDN is enough for the RHDH hub pod.
    this.serviceHost = `${releaseName}.${namespace}.svc`;
    this.servicePort = PQ_HTTPD_HTTPS_PORT;
  }

  getServiceHost(): string {
    if (!this.serviceHost) {
      throw new Error(
        "PQC service host is not set — call deploy(namespace) or resolveService() first",
      );
    }
    return this.serviceHost;
  }

  getServicePort(): number {
    return this.servicePort;
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

  // No per-helper teardown: namespace deletion is owned by the Playwright
  // reporter when CI=true (and retained for local CI=false debugging).

  /** openssl s_client from the RHDH hub pod against this helper's Service host. */
  runSClientFromRhdhPod(group: TlsGroup): OpensslSClientResult {
    return runOpensslSClientFromRhdhPod({
      namespace: this.deploymentConfig.namespace,
      host: this.getServiceHost(),
      port: this.getServicePort(),
      group,
    });
  }

  private async _applyManifests(): Promise<void> {
    const { namespace, configDir } = this.deploymentConfig;
    const configBase = WorkspacePaths.resolve(configDir);
    await $`kubectl apply -f ${path.join(configBase, "httpd.yaml")} -n ${namespace}`;
  }

  private _log(message: string): void {
    console.info(`[PQCHelper] ${message}`);
  }
}
