#!/usr/bin/env bash
set -euo pipefail

REPO="${GH_RELEASE_REPO:-CamilGrondin/Launcher-ESA-2026}"
RELEASE_DIR="${RELEASE_DIR:-release}"
DRY_RUN=0
VERSION=""

usage() {
  cat <<'USAGE'
Usage:
  bash scripts/update-github-release.sh [options] [version]

Options:
  -n, --dry-run   Print actions without uploading/deleting assets
  -h, --help      Show this help

Arguments:
  version         Version number without leading v (example: 0.0.2)
                  If omitted, uses package.json version.

Environment:
  GH_RELEASE_REPO Override GitHub repository (owner/name)
  RELEASE_DIR     Override release artifacts directory (default: release)
USAGE
}

run_cmd() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '[dry-run] '
    printf '%q ' "$@"
    printf '\n'
    return 0
  fi

  "$@"
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    -n|--dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      if [[ -z "$VERSION" ]]; then
        VERSION="$1"
        shift
      else
        echo "Unexpected argument: $1" >&2
        usage
        exit 1
      fi
      ;;
  esac
done

if [[ -z "$VERSION" ]]; then
  VERSION="$(node -p "require('./package.json').version")"
fi

if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Invalid version '$VERSION'. Expected format: x.y.z" >&2
  exit 1
fi

if ! gh auth status -h github.com >/dev/null 2>&1; then
  echo "GitHub CLI is not authenticated. Run: gh auth login" >&2
  exit 1
fi

TAG="v${VERSION}"

SRC_SETUP_EXE="$RELEASE_DIR/GEII ESA Launcher 2026 Setup ${VERSION}.exe"
SRC_SETUP_BLOCKMAP="$RELEASE_DIR/GEII ESA Launcher 2026 Setup ${VERSION}.exe.blockmap"
SRC_MAC_ZIP="$RELEASE_DIR/GEII ESA Launcher 2026-${VERSION}-arm64-mac.zip"
SRC_MAC_ZIP_BLOCKMAP="$RELEASE_DIR/GEII ESA Launcher 2026-${VERSION}-arm64-mac.zip.blockmap"
SRC_MAC_DMG="$RELEASE_DIR/GEII ESA Launcher 2026-${VERSION}-arm64.dmg"
SRC_MAC_DMG_BLOCKMAP="$RELEASE_DIR/GEII ESA Launcher 2026-${VERSION}-arm64.dmg.blockmap"
SRC_LINUX_APPIMAGE="$RELEASE_DIR/GEII ESA Launcher 2026-${VERSION}-arm64.AppImage"
SRC_LATEST_YML="$RELEASE_DIR/latest.yml"
SRC_LATEST_MAC_YML="$RELEASE_DIR/latest-mac.yml"
SRC_LATEST_LINUX_YML="$RELEASE_DIR/latest-linux-arm64.yml"

required_files=(
  "$SRC_SETUP_EXE"
  "$SRC_SETUP_BLOCKMAP"
  "$SRC_MAC_ZIP"
  "$SRC_MAC_ZIP_BLOCKMAP"
  "$SRC_MAC_DMG"
  "$SRC_MAC_DMG_BLOCKMAP"
  "$SRC_LINUX_APPIMAGE"
  "$SRC_LATEST_YML"
  "$SRC_LATEST_MAC_YML"
  "$SRC_LATEST_LINUX_YML"
)

for file in "${required_files[@]}"; do
  if [[ ! -f "$file" ]]; then
    echo "Missing artifact: $file" >&2
    exit 1
  fi
done

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

cp "$SRC_SETUP_EXE" "$TMP_DIR/GEII-ESA-Launcher-2026-Setup-${VERSION}.exe"
cp "$SRC_SETUP_BLOCKMAP" "$TMP_DIR/GEII-ESA-Launcher-2026-Setup-${VERSION}.exe.blockmap"
cp "$SRC_MAC_ZIP" "$TMP_DIR/GEII-ESA-Launcher-2026-${VERSION}-arm64-mac.zip"
cp "$SRC_MAC_ZIP_BLOCKMAP" "$TMP_DIR/GEII-ESA-Launcher-2026-${VERSION}-arm64-mac.zip.blockmap"
cp "$SRC_MAC_DMG" "$TMP_DIR/GEII-ESA-Launcher-2026-${VERSION}-arm64.dmg"
cp "$SRC_MAC_DMG_BLOCKMAP" "$TMP_DIR/GEII-ESA-Launcher-2026-${VERSION}-arm64.dmg.blockmap"
cp "$SRC_LINUX_APPIMAGE" "$TMP_DIR/GEII-ESA-Launcher-2026-${VERSION}-arm64.AppImage"

if ! gh release view "$TAG" -R "$REPO" >/dev/null 2>&1; then
  run_cmd gh release create "$TAG" -R "$REPO" \
    --title "GEII ESA Launcher 2026 ${TAG}" \
    --notes "Release ${TAG}"
fi

run_cmd gh release upload "$TAG" \
  "$TMP_DIR/GEII-ESA-Launcher-2026-Setup-${VERSION}.exe" \
  "$TMP_DIR/GEII-ESA-Launcher-2026-Setup-${VERSION}.exe.blockmap" \
  "$TMP_DIR/GEII-ESA-Launcher-2026-${VERSION}-arm64-mac.zip" \
  "$TMP_DIR/GEII-ESA-Launcher-2026-${VERSION}-arm64-mac.zip.blockmap" \
  "$TMP_DIR/GEII-ESA-Launcher-2026-${VERSION}-arm64.dmg" \
  "$TMP_DIR/GEII-ESA-Launcher-2026-${VERSION}-arm64.dmg.blockmap" \
  "$TMP_DIR/GEII-ESA-Launcher-2026-${VERSION}-arm64.AppImage" \
  "$SRC_LATEST_YML" \
  "$SRC_LATEST_MAC_YML" \
  "$SRC_LATEST_LINUX_YML" \
  --clobber \
  -R "$REPO"

dotted_assets=(
  "GEII.ESA.Launcher.2026-${VERSION}-arm64-mac.zip"
  "GEII.ESA.Launcher.2026-${VERSION}-arm64-mac.zip.blockmap"
  "GEII.ESA.Launcher.2026-${VERSION}-arm64.AppImage"
  "GEII.ESA.Launcher.2026-${VERSION}-arm64.dmg"
  "GEII.ESA.Launcher.2026-${VERSION}-arm64.dmg.blockmap"
  "GEII.ESA.Launcher.2026.Setup.${VERSION}.exe"
  "GEII.ESA.Launcher.2026.Setup.${VERSION}.exe.blockmap"
)

for asset in "${dotted_assets[@]}"; do
  if gh release view "$TAG" -R "$REPO" --json assets --jq ".assets[].name | select(. == \"$asset\")" >/dev/null 2>&1; then
    run_cmd gh release delete-asset "$TAG" "$asset" -R "$REPO" --yes
  fi
done

echo "GitHub release $TAG updated on $REPO"
