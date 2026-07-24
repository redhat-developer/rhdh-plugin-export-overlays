import { GITHUB_ORG } from "../../support/constants/github";

export type RepositoryParameters = {
  repoUrl: string;
  branchName: string;
  targetBranchName: string;
  name: string;
  organization: string;
  gitProviderHost: "github.com" | "gitlab.com";
};

export const defaultGitHubRepositoryParameters = (): RepositoryParameters => {
  const newParams: RepositoryParameters = {
    repoUrl: "",
    branchName: "backstage-integration",
    targetBranchName: "main",
    name: `bulk-import-template-${Date.now()}`,
    organization: GITHUB_ORG,
    gitProviderHost: "github.com",
  };
  newParams.repoUrl = `github.com?owner=${newParams.organization}&repo=${newParams.name}`;

  return newParams;
};

export const defaultGitLabRepositoryParameters = (): RepositoryParameters => {
  const newParams: RepositoryParameters = {
    repoUrl: "",
    branchName: "backstage-integration",
    targetBranchName: "main",
    name: "test-repo",
    organization: "test-org",
    gitProviderHost: "gitlab.com",
  };
  newParams.repoUrl = `gitlab.com?owner=${newParams.organization}&repo=${newParams.name}`;

  return newParams;
};
