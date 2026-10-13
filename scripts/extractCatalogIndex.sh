#!/usr/bin/env bash
#
# Copyright (c) Red Hat, Inc.
#
# Extract catalog-index files from a published plugin-catalog-index image.
#
# The image is `FROM scratch`, so the only way to read what it declares is to pull it and
# unpack a layer. Upstream home of RHDH's e2e-tests/local-harness/catalog-index-refs.sh.
#
# Dest is either:
#   a file      — extract dynamic-plugins.default.yaml there (sanity check)
#   a directory — extract DPDY and index.json independently (version-regression).
#                 Each file's topmost copy is taken on its own walk: a rebuilt index
#                 keeps a stale copy in a lower layer, and mixing those would compare
#                 the previous index while reporting on the current one.
#
# Filenames are fixed, not a parameter: a caller-supplied member name is a `tar`
# extraction surface for nothing.
#
# Exit codes:
#   0  extracted
#   1  confirmed missing image (manifest unknown / 404)
#   2  usage / missing toolchain
#   3  copy/auth/network failure, or the image exists but the requested files are absent
#
# Requires skopeo, jq and tar.
#   extractCatalogIndex.sh quay.io/rhdh/plugin-catalog-index:next /tmp/dpdy.yaml
#   extractCatalogIndex.sh quay.io/rhdh/plugin-catalog-index:next /tmp/previous-index/
set -euo pipefail

IMAGE="${1:-}"
DEST="${2:-}"
DPDY_FILENAME="dynamic-plugins.default.yaml"
INDEX_JSON_FILENAME="index.json"

if [[ -z "$IMAGE" || -z "$DEST" ]]; then
    echo "usage: extractCatalogIndex.sh <catalog-index-image> <dest-file-or-dir>" >&2
    exit 2
fi

for tool in skopeo jq tar; do
    if ! command -v "$tool" > /dev/null 2>&1; then
        echo "extractCatalogIndex.sh needs $tool on PATH" >&2
        exit 2
    fi
done

# Confirmed the registry has no such image. Auth, DNS, and transport failures must
# not match: those are exit 3 so version-regression fails closed instead of skipping.
image_is_missing() {
    local copy_stderr="$1"
    grep -qiE 'manifest unknown|name unknown|status 404|404 not found|was deleted or has not been created' <<<"$copy_stderr"
}

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

# The index is a multi-arch manifest list; without the overrides the copy fails on an
# arm64 host and works on an amd64 runner.
copy_err="${workdir}/skopeo.err"
copy_rc=0
skopeo copy --override-os linux --override-arch amd64 \
    "docker://${IMAGE}" "dir:${workdir}/idx" > /dev/null 2>"$copy_err" || copy_rc=$?
if [[ "$copy_rc" -ne 0 ]]; then
    cat "$copy_err" >&2
    if image_is_missing "$(cat "$copy_err")"; then
        echo "image not found: ${IMAGE}" >&2
        exit 1
    fi
    echo "failed to copy ${IMAGE}" >&2
    exit 3
fi

# Blobs are named by bare digest with no extension, so the layer list comes from
# manifest.json. Layers are base-first, so the effective copy is in the TOPMOST layer
# carrying the file — a rebuilt index keeps a stale copy below, and reading that one
# would validate the previous index.
#
# Read the digests in their own statement: a command substitution that fails inside a
# `for` list does not trip `set -e`, and the run would then blame "not found".
if ! digests="$(jq -r '.layers | reverse | .[].digest' "${workdir}/idx/manifest.json")"; then
    echo "could not read the layer list from ${IMAGE} (bad or missing manifest.json)" >&2
    exit 3
fi

# Pull one tar member from the first (topmost) layer that carries a non-empty copy.
extract_member() {
    local filename="$1"
    local dest_file="$2"
    local digest layer candidate
    candidate="${workdir}/candidate-$(basename "$filename")"
    for digest in $digests; do
        layer="${workdir}/idx/${digest#sha256:}"
        [[ -f "$layer" ]] || continue
        if tar -xOf "$layer" "$filename" > "$candidate" 2> /dev/null \
            && [[ -s "$candidate" ]]; then
            mkdir -p "$(dirname "$dest_file")"
            cp "$candidate" "$dest_file"
            echo "Extracted ${filename} from ${IMAGE} to ${dest_file}"
            return 0
        fi
    done
    return 1
}

if [[ -d "$DEST" ]]; then
    extracted=0
    if extract_member "$DPDY_FILENAME" "$DEST/$DPDY_FILENAME"; then
        extracted=1
    fi
    if extract_member "$INDEX_JSON_FILENAME" "$DEST/$INDEX_JSON_FILENAME"; then
        extracted=1
    fi
    if [[ "$extracted" -eq 0 ]]; then
        echo "${DPDY_FILENAME} and ${INDEX_JSON_FILENAME} not found in ${IMAGE}" >&2
        exit 3
    fi
    exit 0
fi

if extract_member "$DPDY_FILENAME" "$DEST"; then
    exit 0
fi
echo "${DPDY_FILENAME} not found in ${IMAGE}" >&2
exit 3
