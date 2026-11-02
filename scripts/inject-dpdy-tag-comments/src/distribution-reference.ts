// Catalog-index subset of https://github.com/distribution/reference (see reference.go, regexp.go).

const alphanumeric = `[a-z0-9]+`;
const separator = `(?:[._]|__|[-]+)`;
const pathComponent = `${alphanumeric}(?:${separator}${alphanumeric})*`;
const remoteName = `${pathComponent}(?:/${pathComponent})*`;
const domainNameComponent = `[a-z0-9](?:[a-z0-9-]*[a-z0-9])?`;
const domainName = `${domainNameComponent}(?:\\.${domainNameComponent})*`;
const optionalPort = `(?::[0-9]+)?`;
const domainAndPort = `${domainName}${optionalPort}`;
const tag = `[\\w][\\w.-]{0,127}`;
const digest = `sha256:[0-9a-fA-F]{64}`;

function optional(...parts: string[]): string {
  return `(?:${parts.join("")})?`;
}

function anchored(...parts: string[]): string {
  return `^${parts.join("")}$`;
}

const reference = anchored(
  domainAndPort,
  "/",
  `(?<path>${remoteName})`,
  optional(":", `(?<tag>${tag})`),
  optional("@", digest),
);

const referenceRegexp = new RegExp(reference);

export interface ParsedReference {
  path: string;
  tag?: string;
}

/** Parse a reference into repository path and optional tag. */
export function parseReference(raw: string): ParsedReference {
  const groups = referenceRegexp.exec(raw)?.groups;

  if (!groups?.path) {
    throw new Error("Invalid image reference");
  }

  return { path: groups.path, tag: groups.tag };
}
