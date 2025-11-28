import fs from "fs";

function hasSpecFiles(dir: string): boolean {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return false;
  }

  return fs.readdirSync(dir).some((file) => {
    const path = `${dir}/${file}`;
    return (
      file.endsWith(".spec.ts") ||
      (fs.statSync(path).isDirectory() &&
        fs.readdirSync(path).some((f) => f.endsWith(".spec.ts")))
    );
  });
}

export function generateProjects() {
  return fs
    .readdirSync("workspaces")
    .filter((plugin) => hasSpecFiles(`workspaces/${plugin}/e2e-tests`))
    .map((plugin) => ({
      name: plugin,
      testMatch: `**/workspaces/${plugin}/e2e-tests/**/*.spec.ts`,
    }));
}
