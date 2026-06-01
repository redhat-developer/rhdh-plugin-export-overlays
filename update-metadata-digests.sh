#!/usr/bin/env bash

REDHAT_OCI_PREFIX="oci://registry.access.redhat.com/rhdh/"
QUAY_IMAGE_ROOT="docker://quay.io/rhdh"

DEBUG=0
usage() {
  echo "
Update plugin Package metadata so each spec.dynamicArtifact uses the digest
for the latest image tag on Quay for the given release version.
This only impacts GA plugins that are published to RHEC.

Requires:
  git, skopeo, jq, yq (https://github.com/mikefarah/yq/), GNU date

Usage: $0 --version {version} [--workspace {workspace}] [--debug]

Options:
  --debug             enable debug mode
  --version   the release version to update the metadata for (e.g. 1.10)
  --workspace         the workspace to update the metadata for (e.g. orchestrator)

Example:
  $0 --version 1.10
  $0 --version 1.9.4 --workspace orchestrator
"
  exit 1
}

while [[ "$#" -gt 0 ]]; do
  case $1 in
    '--debug') DEBUG=1;;
    '--version') release_version=$2; shift 1;;
    '--workspace') workspaces=$2; shift 1;;
    '--help') usage; exit 0;;
    *) echo "Unknown parameter used: $1."; usage; exit 1;;
  esac
  shift 1
done

die() {
  echo "error: $*" >&2
  echo ""
  usage
}

if [[ -z "$release_version" ]]; then
  die "release-version is required; see $0 --help"
fi

# Quay tags are assumed to resolve to an OCI image index or Docker manifest list.
# Hashing that JSON would yield the *index* digest; we pin the linux/amd64 image manifest digest instead.
platform_image_manifest_digest_from_raw() {
  local raw="$1"
  local digest

  digest="$(jq -r '
    def im:
      .mediaType == "application/vnd.oci.image.manifest.v1+json"
      or .mediaType == "application/vnd.docker.distribution.manifest.v2+json";
    (
      [ .manifests[] | select(im) ]
      | map(select(.platform.os == "linux" and .platform.architecture == "amd64"))
      | first
    )
    // ([ .manifests[] | select(im) ] | first)
    | .digest // empty
  ' <<<"$raw")"
  [[ -n "$digest" ]] || return 1
  printf '%s\n' "$digest"
}

resolve_quay_image_metadata() {
  local plugin="$1" version="$2" release_ver="$3"
  local tag img inspect_json raw

  tag="${release_ver}--${version}"
  img="${QUAY_IMAGE_ROOT}/${plugin}:${tag}"

  if ! inspect_json="$(skopeo inspect "$img")"; then
    echo "[ERROR] could not inspect image: $img" >&2
    return 1
  fi

  raw="$(skopeo inspect --raw "$img")"
  digest="$(platform_image_manifest_digest_from_raw "$raw")"
  rhdh_ver="$(jq -r '.Labels["rhdh.version"] // empty' <<<"$inspect_json")"
  build_date="$(jq -r '.Labels["build-date"] // empty' <<<"$inspect_json")"
  if [[ -z "$digest" || -z "$build_date" || -z "$rhdh_ver" ]]; then
    return 1
  fi
}

update_dynamic_artifact_comment() {
  local file="$1" tag_comment="$2" build_date="$3"
  local comment_line="  # Tag: ${tag_comment}, Build date: ${build_date}"

  if grep -q '^  # Tag:.*Build date:' "$file"; then
    sed -i "s|^  # Tag:.*|${comment_line}|" "$file"
    return
  fi

  local tmp
  tmp="$(mktemp "${TMPDIR:-/tmp}/update-metadata-digests.XXXXXX")"
  awk -v c="$comment_line" '
    /^  dynamicArtifact:/ && !inserted {
      print c
      inserted = 1
    }
    { print }
  ' "$file" >"$tmp"
  mv "$tmp" "$file"
}


if [[ -z "$release_version" || "$release_version" == "-h" || "$release_version" == "--help" ]]; then
  usage
fi

if ! [[ "$release_version" =~ ^[0-9]+\.[0-9]+([.][0-9]+)?$ ]]; then
  die "release-version must look like 1.y or 1.y.z (got: ${release_version}); see $0 --help"
fi

if ! repo_root="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  die "run from inside the git repository"
fi

cd "$repo_root"

if [[ -z "$workspaces" ]]; then
  workspaces="$(ls -1 workspaces/)"
fi

for workspace in $workspaces; do
  if ! [[ -d "${repo_root}/workspaces/${workspace}/metadata" ]]; then
    if [[ "$DEBUG" -eq 1 ]]; then
      echo "[DEBUG] skip workspace: $workspace: no metadata files found"
    fi
    continue
  fi
  for f in "${repo_root}/workspaces/${workspace}/metadata"/*.yaml; do
    artifact="$(yq -r '.spec.dynamicArtifact // ""' "$f")"

    if [[ -z "$artifact" || "$artifact" == "null" ]]; then
      if [[ "$DEBUG" -eq 1 ]]; then
        echo "[DEBUG] skip $(basename "$f"): missing spec.dynamicArtifact"
      fi
      continue
    fi

    if [[ "$artifact" != "${REDHAT_OCI_PREFIX}"* ]]; then
      if [[ "$DEBUG" -eq 1 ]]; then
        echo "[DEBUG] skip $(basename "$f"): dynamicArtifact is not pointing to a Red Hat registry image"
      fi
      continue
    fi

    plugin="${artifact#$REDHAT_OCI_PREFIX}"
    plugin="${plugin%%@*}"

    version="$(yq -r '.spec.version // ""' "$f")"
    if [[ -z "$version" || "$version" == "null" ]]; then
      die "$(basename "$f"): missing spec.version"
    fi

    tag="${release_version}--${version}"
    if ! resolve_quay_image_metadata "$plugin" "$version" "$release_version"; then
      echo "[ERROR] could not resolve manifest digest / labels for quay.io/rhdh/${plugin} (tag ${tag})"
      continue
    fi
    tag_comment="${rhdh_ver}--${version}"
    new_artifact="${REDHAT_OCI_PREFIX}${plugin}@${digest}"
    _UPDATE_METADATA_DIGESTS_URI="$new_artifact" yq eval -i \
      '.spec.dynamicArtifact = strenv(_UPDATE_METADATA_DIGESTS_URI)' "$f"

    update_dynamic_artifact_comment "$f" "$tag_comment" "$build_date"
    if [[ "$DEBUG" -eq 1 ]]; then
      echo "[DEBUG] updated $(basename "$f"): ${plugin} @ ${digest} (${tag_comment}, ${build_date})"
    fi
  done
done
