import * as k8s from "@kubernetes/client-node";
import { KubernetesClientHelper } from "@red-hat-developer-hub/e2e-test-utils/utils";

export class KubeClient extends KubernetesClientHelper {
  private readonly kc: k8s.KubeConfig;
  private readonly k8sApi: k8s.CoreV1Api;

  constructor() {
    super();
    this.kc = new k8s.KubeConfig();
    this.kc.loadFromDefault();

    try {
      this.k8sApi = this.kc.makeApiClient(k8s.CoreV1Api);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("No active cluster")
      ) {
        const currentContext = this.kc.getCurrentContext();
        const contexts = this.kc.getContexts().map((c) => c.name);

        throw new Error(
          `No active Kubernetes cluster found.\n\n` +
            `The kubeconfig was loaded but no cluster is configured or the current context is invalid.\n\n` +
            `Current context: ${currentContext || "(none)"}\n` +
            `Available contexts: ${contexts.length > 0 ? contexts.join(", ") : "(none)"}\n\n` +
            `To fix this:\n` +
            `  1. Log in to your k8s cluster: oc login or kubectl login\n` +
            `  2. Or set a valid context: kubectl config use-context <context-name>\n` +
            `  3. Verify your connection: oc whoami && oc cluster-info\n\n` +
            `Kubeconfig locations checked:\n` +
            `  - KUBECONFIG env: ${process.env.KUBECONFIG || "(not set)"}\n` +
            `  - Default: ~/.kube/config`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  async getNamespaceByName(
    name: k8s.CoreV1ApiReadNamespaceRequest,
  ): Promise<k8s.V1Namespace | null> {
    try {
      return await this.k8sApi.readNamespace(name);
    } catch (error) {
      // A namespace that does not exist yet is an expected state while polling
      // for the scaffolder action to complete — treat 404 as "not found" rather
      // than aborting the poll.
      if (this.isNotFoundError(error)) {
        return null;
      }
      console.log(
        `Error getting namespace ${JSON.stringify(name)}: ${error instanceof Error ? error.message : error}`,
      );
      throw error;
    }
  }

  private isNotFoundError(error: unknown): boolean {
    if (error instanceof k8s.ApiException) {
      return error.code === 404;
    }
    // Fall back to duck-typing for other client error shapes.
    const statusCode = (error as { statusCode?: number; code?: number })
      ?.statusCode;
    const code = (error as { code?: number })?.code;
    return statusCode === 404 || code === 404;
  }
}
