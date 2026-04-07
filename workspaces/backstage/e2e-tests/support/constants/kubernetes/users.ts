export type RbacUser = {
  username: string;
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  groups: string[];
};

export const KUBERNETES_USERS: Record<string, RbacUser> = {
  kubernetesReader: {
    username: "kubernetes-reader",
    firstName: "Kubernetes",
    lastName: "Reader",
    email: "kubernetes-reader@example.com",
    password: crypto.randomUUID().substring(0, 21).replaceAll("-", "0"),
    groups: [],
  },
  kubernetesLogsReader: {
    username: "kubernetes-logs-reader",
    firstName: "KubernetesLogs",
    lastName: "Reader",
    email: "kubernetes-logs-reader@example.com",
    password: crypto.randomUUID().substring(0, 21).replaceAll("-", "0"),
    groups: [],
  },
  noKubernetesAccess: {
    username: "no-kubernetes-access",
    firstName: "No",
    lastName: "KubernetesAccess",
    email: "no-kubernetes-access@example.com",
    password: crypto.randomUUID().substring(0, 21).replaceAll("-", "0"),
    groups: [],
  },
};
