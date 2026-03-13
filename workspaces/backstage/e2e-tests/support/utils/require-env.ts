export function requireEnv(...names: [string, ...string[]]): void {
  for (const name of names) {
    const value = process.env[name];
    if (!value) {
      throw new Error(`${name} environment variable is required`);
    }
  }
}
