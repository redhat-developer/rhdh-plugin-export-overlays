export function defaultCatalogInfoYaml(
  componentName: string,
  projectSlug: string,
  owner: string,
): string {
  return `apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: ${componentName}
  annotations:
    github.com/project-slug: ${projectSlug}
spec:
  type: other
  lifecycle: unknown
  owner: user:default/${owner}
`;
}

export function githubCatalogOwnerFromEnv(): string {
  return process.env.VAULT_GH_USER_ID?.trim() || "test1";
}
