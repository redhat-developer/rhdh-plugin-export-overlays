import { test } from "@red-hat-developer-hub/e2e-test-utils/test";

type PrefixedScaffolderState = {
  testPrefix: string;
};

/**
 * Creates the per-project scaffolder prefix once, deploys the hub once, and
 * returns the state file contents for this worker.
 */
export async function ensureScaffolderState<
  T extends PrefixedScaffolderState,
>(options: {
  projectName: string;
  runOnceKey: string;
  readState: (projectName: string) => T;
  writeState: (projectName: string, state: T) => void;
  generatePrefix: () => string;
  deploy: () => Promise<void>;
}): Promise<T> {
  const {
    projectName,
    runOnceKey,
    readState,
    writeState,
    generatePrefix,
    deploy,
  } = options;

  await test.runOnce(runOnceKey, async () => {
    const state = readState(projectName);
    if (!state.testPrefix) {
      state.testPrefix = generatePrefix();
      writeState(projectName, state);
    }
    await deploy();
  });

  return readState(projectName);
}
