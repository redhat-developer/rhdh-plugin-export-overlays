#!/usr/bin/env node
import { execSync } from "child_process";

const pluginName: string | undefined = process.argv[2];
const extraArgs: string = process.argv.slice(3).join(" "); // Pass through additional playwright args

if (!pluginName) {
  console.error("Error: Please provide a plugin name");
  process.exit(1);
}

const command: string = `playwright test --project ${pluginName} ${extraArgs}`;

console.log(`Running: ${command}\n`);

try {
  execSync(command, { stdio: "inherit" });
} catch (error) {
  const exitCode = (error as { status?: number }).status || 1;
  process.exit(exitCode);
}
