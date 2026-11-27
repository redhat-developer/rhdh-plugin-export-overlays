import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * State the discovery suite shares across worker restarts. The project is
 * created under test.runOnce, so a restarted worker reads these instead of
 * creating a second project.
 */
export interface GitLabDiscoverySharedState {
  entityName: string;
  projectId: number;
}

function getDiscoveryStateFilePath(playwrightProjectName: string): string {
  const safeName = playwrightProjectName.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(os.tmpdir(), `backstage-gitlab-discovery-${safeName}.json`);
}

export function readGitLabDiscoverySharedState(
  playwrightProjectName: string,
): GitLabDiscoverySharedState | undefined {
  const stateFile = getDiscoveryStateFilePath(playwrightProjectName);
  if (!fs.existsSync(stateFile)) {
    return undefined;
  }
  return JSON.parse(
    fs.readFileSync(stateFile, "utf8"),
  ) as GitLabDiscoverySharedState;
}

export function writeGitLabDiscoverySharedState(
  playwrightProjectName: string,
  state: GitLabDiscoverySharedState,
): void {
  fs.writeFileSync(
    getDiscoveryStateFilePath(playwrightProjectName),
    JSON.stringify(state, null, 2),
    "utf8",
  );
}

export function requireGitLabDiscoverySharedState(
  playwrightProjectName: string,
): GitLabDiscoverySharedState {
  const state = readGitLabDiscoverySharedState(playwrightProjectName);
  if (!state?.projectId) {
    throw new Error(
      "GitLab discovery shared state is missing; the runOnce setup did not complete",
    );
  }
  return state;
}

export function deleteGitLabDiscoverySharedState(
  playwrightProjectName: string,
): void {
  const stateFile = getDiscoveryStateFilePath(playwrightProjectName);
  if (fs.existsSync(stateFile)) {
    fs.unlinkSync(stateFile);
  }
}
