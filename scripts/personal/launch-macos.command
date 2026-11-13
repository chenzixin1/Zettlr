#!/bin/sh
set -eu

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
case "$(uname -m)" in
  arm64) PERSONAL_ARCH=arm64 ;;
  x86_64) PERSONAL_ARCH=x64 ;;
  *) echo 'Unsupported Mac architecture.' >&2; exit 1 ;;
esac

PERSONAL_APP=${ZETTLR_PERSONAL_APP:-"$REPO_ROOT/out/Zettlr Personal-darwin-$PERSONAL_ARCH/Zettlr Personal.app"}
PERSONAL_DATA=${ZETTLR_PERSONAL_DATA_DIR:-"$REPO_ROOT/out/personal-profile"}
if [ ! -d "$PERSONAL_APP" ]; then
  echo 'Build Zettlr Personal first: yarn package:personal:mac' >&2
  exit 1
fi
mkdir -p "$PERSONAL_DATA"

# Electron applies user-data-dir before Zettlr acquires its instance lock;
# Zettlr's data-dir also directs its configuration and logs to this profile.
exec "$PERSONAL_APP/Contents/MacOS/Zettlr Personal" \
  --user-data-dir="$PERSONAL_DATA" --data-dir="$PERSONAL_DATA" "$@"
