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

export { githubCatalogOwner as githubCatalogOwnerFromEnv } from "../utils/github-credentials";
