/** Runs cleanup and reports whether it finished. Failures are logged, not thrown. */
export async function runGitHubCleanupSafely(
  cleanup: () => Promise<void>,
): Promise<boolean> {
  try {
    await cleanup();
    return true;
  } catch (error) {
    console.warn(
      `Cleanup error: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}
