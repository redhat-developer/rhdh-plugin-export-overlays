import { APIHelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";

export interface GitHubPR {
  title: string;
  number: number;
}

export async function getGitHubPRs(
  state: "open" | "closed" | "all",
  paginated = false,
): Promise<GitHubPR[]> {
  return (await APIHelper.getGitHubPRs(
    "redhat-developer",
    "rhdh",
    state,
    paginated,
  )) as GitHubPR[];
}
