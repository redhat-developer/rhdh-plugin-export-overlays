/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0.
 */

/**
 * How the install CLI reads an `oci://` ref and picks the plugin it installs.
 *
 * Shared with the workspace metadata validator in
 * scripts/validate-app-config-examples, which imports this file by path. Keep it free
 * of imports so it runs both bundled here and under Node's type stripping there.
 */

const OCI_PREFIX = "oci://";

/**
 * The `registry/repo[:tag][@digest]` a ref names, as skopeo takes it after
 * `docker://`. The `!plugin-path` selector is dropped: it picks a plugin inside the
 * image and is not part of the image reference.
 */
export function registryRefFromOciRef(ref: string): string {
  if (!ref.startsWith(OCI_PREFIX)) {
    throw new Error(`not an ${OCI_PREFIX} ref: ${ref}`);
  }
  return ref.slice(OCI_PREFIX.length).split("!")[0] ?? "";
}

// The install CLI's registry fallback (resolveImage in cli-module-install-dynamic-plugins):
// an image under the productized registry that is not there yet is pulled from quay
// instead. An RC index points at exactly such images, so a probe that skipped this
// would leave out packages the CLI installs without complaint.
const RHDH_REGISTRY = "registry.access.redhat.com/rhdh/";
const RHDH_FALLBACK = "quay.io/rhdh/";

/**
 * The image references to probe for a ref, in the order the install CLI tries them:
 * the one it names, then the quay fallback when it names the productized registry.
 */
export function probeCandidates(ref: string): string[] {
  const primary = registryRefFromOciRef(ref);
  return primary.startsWith(RHDH_REGISTRY)
    ? [primary, RHDH_FALLBACK + primary.slice(RHDH_REGISTRY.length)]
    : [primary];
}

/**
 * Whether the install CLI's OCI_REGEX (oci-key in cli-module-install-dynamic-plugins)
 * accepts a ref: `oci://host[:port]/path` with a tag or a digest, then an optional
 * non-empty `!<path>`. Parsed by hand; the one-regex form backtracks badly.
 */
export function isInstallableOciRef(ref: string): boolean {
  if (!ref.startsWith(OCI_PREFIX) || /\s/.test(ref)) return false;
  const body = ref.slice(OCI_PREFIX.length);
  const bang = body.indexOf("!");
  if (bang === body.length - 1) return false;
  const image = bang === -1 ? body : body.slice(0, bang);
  const at = image.indexOf("@");
  let name: string;
  if (at === -1) {
    const colon = image.lastIndexOf(":");
    const tag = image.slice(colon + 1);
    if (colon === -1 || tag === "") return false;
    name = image.slice(0, colon);
  } else {
    if (!/^(?:sha256|sha512|blake3):[^!@:]+$/.test(image.slice(at + 1)))
      return false;
    name = image.slice(0, at);
  }
  const [host = "", ...segments] = name.split("/");
  return (
    segments.length > 0 &&
    segments.every((segment) => segment !== "" && !/[:@]/.test(segment)) &&
    /^[^/:@]+(?::\d+)?$/.test(host)
  );
}

export const DYNAMIC_PACKAGES_ANNOTATION = "io.backstage.dynamic-packages";

/** A ref's `!plugin-path` selector: undefined without one, "" for a bare `!`. */
export function pluginSelector(ref: string): string | undefined {
  const bang = ref.indexOf("!");
  return bang === -1 ? undefined : ref.slice(bang + 1);
}

export type DeclaredPluginPaths = { paths: string[] } | { problem: string };

/**
 * The plugin paths a manifest declares, decoded as the install CLI's `getPluginPaths`
 * does: the annotation is base64 JSON, a list of `{<path>: <package.json>}` objects.
 */
export function declaredPluginPaths(manifestJson: string): DeclaredPluginPaths {
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestJson);
  } catch (err) {
    return { problem: `manifest is not JSON: ${errorText(err)}` };
  }
  const annotations = isRecord(manifest) ? manifest.annotations : undefined;
  const annotation = isRecord(annotations)
    ? annotations[DYNAMIC_PACKAGES_ANNOTATION]
    : undefined;
  if (typeof annotation !== "string" || annotation === "") {
    return {
      problem: `no plugins declared: the '${DYNAMIC_PACKAGES_ANNOTATION}' annotation is missing or empty`,
    };
  }
  let entries: unknown;
  try {
    entries = JSON.parse(Buffer.from(annotation, "base64").toString("utf8"));
  } catch {
    return {
      problem: `the '${DYNAMIC_PACKAGES_ANNOTATION}' annotation is not base64-encoded JSON`,
    };
  }
  const paths = Array.isArray(entries)
    ? entries.flatMap((entry: unknown) =>
        entry && typeof entry === "object" ? Object.keys(entry) : [],
      )
    : [];
  if (paths.length === 0) {
    return {
      problem: `no plugins declared: the '${DYNAMIC_PACKAGES_ANNOTATION}' annotation lists none`,
    };
  }
  return { paths };
}

/**
 * Why the install CLI would refuse this manifest, or undefined when it would not.
 *
 * Mirrors the CLI's plugin-path auto-detection (`getPluginPaths` / `ociPluginKey` in
 * cli-module-install-dynamic-plugins): a ref with no `!plugin-path` selector needs the
 * `io.backstage.dynamic-packages` annotation to name exactly one plugin, and anything
 * else is an InstallException that aborts the whole install. The `next` index shipped
 * a scorecard module whose annotation was the empty string — the image exists, and
 * nothing can be installed from it.
 */
export function pluginPathProblem(
  ref: string,
  manifestJson: string,
): string | undefined {
  if (pluginSelector(ref) !== undefined) return undefined;
  const declared = declaredPluginPaths(manifestJson);
  if ("problem" in declared) return declared.problem;
  if (declared.paths.length > 1) {
    return `${declared.paths.length} plugins in the image (${declared.paths.join(", ")}) and no '!plugin-path' selector to pick one`;
  }
  return undefined;
}

/**
 * pluginPathProblem, plus the selector check the install CLI does not make: a selector
 * naming a path the image does not declare extracts nothing, and the install still
 * exits 0, so the plugin silently never loads.
 */
export function selectedPluginPathProblem(
  ref: string,
  manifestJson: string,
): string | undefined {
  if (!isInstallableOciRef(ref)) {
    return "is not a ref the install CLI accepts (oci://<registry>/<repo> with a tag or digest, then an optional !<path>)";
  }
  const selector = pluginSelector(ref);
  if (selector === undefined) return pluginPathProblem(ref, manifestJson);
  const declared = declaredPluginPaths(manifestJson);
  if ("problem" in declared)
    return `selects !${selector}, but ${declared.problem}`;
  if (!declared.paths.includes(selector)) {
    return `selects !${selector}, but the image declares ${declared.paths.join(", ")}`;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
