import { APIHelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";

const STATE_QUERY = {
  open: "state:open ",
  closed: "state:closed ",
  all: "",
} as const;

const REPO_OWNER = "redhat-developer";
const REPO_NAME = "rhdh";
const GH_MAX_RESULTS = 1000;
const GH_MAX_PER_PAGE = 100;

export interface GitHubPR {
  title: string;
  number: number;
}

export async function searchGitHubPRs(
  state: keyof typeof STATE_QUERY,
): Promise<GitHubPR[]> {
  const stateFilter = STATE_QUERY[state];

  const query = encodeURIComponent(
    `${stateFilter}type:pr repo:${REPO_OWNER}/${REPO_NAME}`,
  );

  const results: GitHubPR[] = [];
  let page = 1;

  while (results.length < GH_MAX_RESULTS) {
    const url = `https://api.github.com/search/issues?q=${query}&per_page=${GH_MAX_PER_PAGE}&page=${page}`;
    const response = await APIHelper.githubRequest("GET", url);
    const body = await response.json();
    const items = body.items ?? [];

    if (items.length === 0) {
      break;
    }

    for (const item of items) {
      results.push({ title: item.title, number: item.number });
    }

    page++;
  }

  return results.slice(0, GH_MAX_RESULTS);
}
