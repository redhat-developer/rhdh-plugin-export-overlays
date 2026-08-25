#!/usr/bin/env bash
#
# Copyright (c) Red Hat, Inc.
#
# Extract dynamic-plugins.default.yaml from a published plugin-catalog-index image.
#
# The catalog index image is `FROM scratch` — it carries no shell and nothing to exec,
# so the only way to read what it declares is to pull it and unpack a layer. This is the
# upstream home of the logic RHDH carries in
# e2e-tests/local-harness/catalog-index-refs.sh: with it here, the same sanity check can
# run against an index that is about to be generated (scripts/update-index.sh --sanity-check,
# no image needed) or against one that is already published (this script), from one
# implementation.
#
# Requires skopeo, jq and tar. Usage:
#   extractCatalogIndex.sh quay.io/rhdh/plugin-catalog-index:next /tmp/dpdy.yaml
#
# Then:
#   cd smoke-tests-native && yarn smoke --catalog-index /tmp/dpdy.yaml
set -euo pipefail

IMAGE="${1:-}"
DEST="${2:-}"
FILENAME="${3:-dynamic-plugins.default.yaml}"

if [[ -z "$IMAGE" || -z "$DEST" ]]; then
    echo "usage: extractCatalogIndex.sh <catalog-index-image> <dest-file> [file-in-image]" >&2
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

# Platform overrides keep instance selection working on any host: the index is a
# multi-arch manifest list, and without them the copy fails on e.g. an arm64 macOS
# developer machine while working fine on an amd64 runner.
skopeo copy --override-os linux --override-arch amd64 \
    "docker://${IMAGE}" "dir:${workdir}/idx" > /dev/null

# Layer blobs in a `skopeo copy … dir:` layout are named by their bare sha256 digest
# with no extension, so the layer list has to come from manifest.json; tar auto-detects
# gzip-compressed layers.
#
# Layers are listed base-first, so the EFFECTIVE copy of the file is the one in the
# TOPMOST layer that carries it — an index rebuilt as an overlay keeps a stale copy in a
# lower layer, and reading that one would validate the previous index. Walk top-down and
# take the first hit.
# Read the digests in a separate statement rather than inline in the `for`: a command
# substitution that fails inside a `for` list does not trip `set -e`, so a missing or
# malformed manifest.json would silently produce an empty loop and the run would then
# report "not found in <image>" — pointing at the wrong cause entirely.
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
