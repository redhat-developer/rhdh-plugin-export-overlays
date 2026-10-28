// Catalog-index subset of https://github.com/distribution/reference (see reference.go, regexp.go).

const domainLabel = `[a-z0-9](?:[a-z0-9-]*[a-z0-9])?`;
const registryHost = `${domainLabel}(?:\\.${domainLabel})*`;
const pathSegment = `[a-z0-9]+(?:-[a-z0-9]+)*`;
const repositoryPath = `${pathSegment}(?:/${pathSegment})*`;
const tagSegment = `[\\w][\\w.-]{0,127}`;
const digest = `sha256:[0-9a-fA-F]{64}`;

function optional(...parts: string[]): string {
  return `(?:${parts.join("")})?`;
}

function anchored(...parts: string[]): string {
  return `^${parts.join("")}$`;
}

const reference = anchored(
  registryHost,
  "/",
  `(?<path>${repositoryPath})`,
  optional(":", `(?<tag>${tagSegment})`),
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
