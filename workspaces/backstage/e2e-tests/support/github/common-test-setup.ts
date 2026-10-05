export async function runGitHubCleanupSafely(
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
