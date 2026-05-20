/** GitHub browser-login credentials (Vault naming preferred in CI). */
export function getGitHubLoginCredentials(): {
  user: string | undefined;
  pass: string | undefined;
} {
  const user =
    process.env.VAULT_GH_USER_ID?.trim() || process.env.GITHUB_USERNAME?.trim();
  const pass =
    process.env.VAULT_GH_USER_PASS?.trim() ||
    process.env.GITHUB_PASSWORD?.trim();
  return { user, pass };
}

/** Backstage catalog owner entity for generated catalog-info.yaml. */
export function githubCatalogOwner(): string {
  return process.env.VAULT_GH_USER_ID?.trim() || "test1";
}
