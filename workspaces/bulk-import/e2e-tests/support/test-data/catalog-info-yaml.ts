import { GITHUB_CATALOG_OWNER } from "../constants/github";

export function defaultCatalogInfoYaml(
  componentName: string,
  projectSlug: string,
  owner: string = GITHUB_CATALOG_OWNER,
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
