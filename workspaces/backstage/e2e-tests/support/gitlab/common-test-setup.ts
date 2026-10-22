import { GitLabApiHelper } from "../api/gitlab-api-helper.js";

export async function prepareGitLabParentGroup(
  parentGroupPath: string | undefined,
): Promise<{
  parentGroupId: number;
  parentGroupPath: string;
}> {
  const parentGroup = await GitLabApiHelper.getGroupByPath(parentGroupPath);
  await GitLabApiHelper.cleanupStaleResources(parentGroup.id, "e2e-", 1);
  return {
    parentGroupId: parentGroup.id,
    parentGroupPath: parentGroup.full_path,
  };
}

export async function runGitLabCleanupSafely(
  cleanup: () => Promise<void>,
): Promise<void> {
  try {
    await cleanup();
  } catch (error) {
    console.warn(
      `Cleanup error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
