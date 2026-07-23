#!/usr/bin/env bash
#
# Copyright (c) Red Hat, Inc.
#
# Package a prepared workspace source tree and push it as an OCI artifact.
# Contract: RHIDP-15699 / RHDHPLAN-1568
#
# Usage:
#   push-prepared-source.sh \
#     --dir <workspace-source-dir> \
#     --image quay.io/rhdh/prepared-sources/<workspace>:<tag> \
#     --overlay-commit <sha> \
#     --source-ref <git-ref>
#
set -euo pipefail

DIR=""
IMAGE=""
OVERLAY_COMMIT=""
SOURCE_REF=""
ARTIFACT_TYPE="application/vnd.rhdh.prepared-source.v1+tar"
LAYER_MEDIA_TYPE="application/vnd.oci.image.layer.v1.tar+gzip"
WORKDIR=""

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

cleanup() {
  if [[ -n "${WORKDIR}" && -d "${WORKDIR}" ]]; then
    rm -rf "${WORKDIR}"
  fi
}
trap cleanup EXIT

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)
      DIR="${2:-}"
      shift 2
      ;;
    --image)
      IMAGE="${2:-}"
      shift 2
      ;;
    --overlay-commit)
      OVERLAY_COMMIT="${2:-}"
      shift 2
      ;;
    --source-ref)
      SOURCE_REF="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage 0
      ;;
    *)
      echo "[ERROR] Unknown argument: $1" >&2
      usage 1
      ;;
  esac
done

if [[ -z "${DIR}" || -z "${IMAGE}" || -z "${OVERLAY_COMMIT}" || -z "${SOURCE_REF}" ]]; then
  echo "[ERROR] --dir, --image, --overlay-commit, and --source-ref are required" >&2
  usage 1
fi

if [[ ! -d "${DIR}" ]]; then
  echo "[ERROR] Directory does not exist: ${DIR}" >&2
  exit 1
fi

if ! command -v oras >/dev/null 2>&1; then
  echo "[ERROR] oras is required on PATH" >&2
  exit 1
fi

if ! command -v tar >/dev/null 2>&1; then
  echo "[ERROR] tar is required on PATH" >&2
  exit 1
fi

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/prepared-source.XXXXXX")"
ARCHIVE="${WORKDIR}/prepared-source.tar.gz"

# Match midstream cleanup intent: ship sources + lockfiles + dist-dynamic keepers,
# not local install caches or VCS metadata.
tar -czf "${ARCHIVE}" \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='.yarn/cache' \
  --exclude='.yarn/install-state.gz' \
  --exclude='.backstage-manifest-cache' \
  --exclude='*.orig' \
  --exclude='*.rej' \
  --exclude='.forceclone' \
  -C "${DIR}" \
  .

echo "[INFO] Pushing prepared source artifact: ${IMAGE}"
echo "[INFO]   overlay-commit=${OVERLAY_COMMIT}"
echo "[INFO]   source-ref=${SOURCE_REF}"
echo "[INFO]   archive=$(du -h "${ARCHIVE}" | awk '{print $1}')"

oras push "${IMAGE}" \
  --artifact-type "${ARTIFACT_TYPE}" \
  --annotation "org.rhdh.overlay-commit=${OVERLAY_COMMIT}" \
  --annotation "org.rhdh.source-ref=${SOURCE_REF}" \
  "${ARCHIVE}:${LAYER_MEDIA_TYPE}"

echo "[INFO] Pushed ${IMAGE}"
