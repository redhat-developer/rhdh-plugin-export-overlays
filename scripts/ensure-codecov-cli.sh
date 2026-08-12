#!/usr/bin/env bash
#
# Download and checksum-verify the Codecov CLI at <target-path>, unless an
# executable is already there.
#
# Usage:
#   ./scripts/ensure-codecov-cli.sh [target-path]   # default: /tmp/codecov
#
# Extracted from upload-coverage.sh so the upstream upload path reuses one
# verified downloader instead of carrying a second copy that can drift to a
# different pinned version — two uploaders disagreeing about which CLI they run
# is exactly the kind of difference that only shows up as an odd Codecov result.
#
# Uses the standalone Go binary (not pip codecov-cli) for supply-chain safety,
# and refuses to leave an unverified binary behind: a failed checksum removes the
# download rather than letting the next run find it and skip the check.

set -euo pipefail

TARGET="${1:-/tmp/codecov}"

# Pinned deliberately. Bumping is a supply-chain decision, not a maintenance
# chore — the checksum below is fetched from the same host as the binary, so the
# version pin is what bounds what can arrive.
readonly CODECOV_VERSION="v11.2.8"

# shellcheck disable=SC2016  # an awk program, not a shell expansion
readonly AWK_FIRST_FIELD='{print $1}'

if [[ -x "$TARGET" ]]; then
  exit 0
fi

OS=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$OS" in
  linux)  CODECOV_OS="linux" ;;
  darwin) CODECOV_OS="macos" ;;
  *)
    echo "ERROR: Unsupported OS: $OS" >&2
    exit 1
    ;;
esac

echo "Downloading Codecov CLI $CODECOV_VERSION for ${CODECOV_OS}..."
BASE="https://cli.codecov.io/${CODECOV_VERSION}/${CODECOV_OS}"
# -L follows redirects, and the fetched bytes are about to be executed. Without
# the protocol pins, a redirect could send the download to plaintext HTTP, where
# both the binary AND the checksum used to verify it come from the same
# tamperable channel — the verification below would then confirm nothing.
#
# The pins stay written out here rather than behind a variable: static analysis
# cannot see inside an expansion, so the indirect form reads as an unpinned
# `curl -sL` to any scanner — or reviewer — checking this property. One
# invocation fetches both artifacts, which is what keeps that from meaning a
# repeated flag list: they always come from the same base and are useless apart.
curl -sL --proto '=https' --proto-redir '=https' --tlsv1.2 \
  -o "$TARGET" "$BASE/codecov" \
  -o "${TARGET}.SHA256SUM" "$BASE/codecov.SHA256SUM"

EXPECTED=$(awk "$AWK_FIRST_FIELD" "${TARGET}.SHA256SUM")
if command -v sha256sum &>/dev/null; then
  ACTUAL=$(sha256sum "$TARGET" | awk "$AWK_FIRST_FIELD")
else
  ACTUAL=$(shasum -a 256 "$TARGET" | awk "$AWK_FIRST_FIELD")
fi
rm -f "${TARGET}.SHA256SUM"

if [[ "$EXPECTED" != "$ACTUAL" ]]; then
  echo "ERROR: Codecov CLI checksum verification failed" >&2
  echo "  Expected: $EXPECTED" >&2
  echo "  Actual:   $ACTUAL" >&2
  rm -f "$TARGET"
  exit 1
fi

chmod +x "$TARGET"
echo "  Codecov CLI downloaded and verified"
