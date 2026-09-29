#!/usr/bin/env bash
#
# Copyright (c) Red Hat, Inc.
#
# Extract dynamic-plugins.default.yaml from a published plugin-catalog-index image.
#
# The image is `FROM scratch`, so the only way to read what it declares is to pull it and
# unpack a layer. Upstream home of RHDH's e2e-tests/local-harness/catalog-index-refs.sh.
#
# Requires skopeo, jq and tar.
#   extractCatalogIndex.sh quay.io/rhdh/plugin-catalog-index:next /tmp/dpdy.yaml
set -euo pipefail

IMAGE="${1:-}"
DEST="${2:-}"
# Fixed, not a parameter: an index image carries exactly one file anyone wants, no
# caller ever passed it, and a caller-supplied member name is a `tar` extraction
# surface for nothing. Re-add it with a test if the index.json case is ever built.
FILENAME="dynamic-plugins.default.yaml"

if [[ -z "$IMAGE" || -z "$DEST" ]]; then
    echo "usage: extractCatalogIndex.sh <catalog-index-image> <dest-file>" >&2
    exit 2
fi

for tool in skopeo jq tar; do
    if ! command -v "$tool" > /dev/null 2>&1; then
        echo "extractCatalogIndex.sh needs $tool on PATH" >&2
        exit 2
    fi
done

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

# The index is a multi-arch manifest list; without the overrides the copy fails on an
# arm64 host and works on an amd64 runner.
skopeo copy --override-os linux --override-arch amd64 \
    "docker://${IMAGE}" "dir:${workdir}/idx" > /dev/null

# Blobs are named by bare digest with no extension, so the layer list comes from
# manifest.json. Layers are base-first, so the effective copy is in the TOPMOST layer
# carrying the file — a rebuilt index keeps a stale copy below, and reading that one
# would validate the previous index.
#
# Read the digests in their own statement: a command substitution that fails inside a
# `for` list does not trip `set -e`, and the run would then blame "not found".
if ! digests="$(jq -r '.layers | reverse | .[].digest' "${workdir}/idx/manifest.json")"; then
    echo "could not read the layer list from ${IMAGE} (bad or missing manifest.json)" >&2
    exit 1
fi

found=""
for digest in $digests; do
    layer="${workdir}/idx/${digest#sha256:}"
    [[ -f "$layer" ]] || continue
    if tar -xOf "$layer" "$FILENAME" > "${workdir}/candidate" 2> /dev/null \
        && [[ -s "${workdir}/candidate" ]]; then
        found="${workdir}/candidate"
        break
    fi
done

if [[ -z "$found" ]]; then
    echo "${FILENAME} not found in ${IMAGE}" >&2
    exit 1
fi

mkdir -p "$(dirname "$DEST")"
cp "$found" "$DEST"
echo "Extracted ${FILENAME} from ${IMAGE} to ${DEST}"
