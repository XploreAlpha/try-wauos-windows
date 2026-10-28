#!/usr/bin/env bash

# Fetch the pinned Wau OS package that the guest image installs.
#
# The package is a release asset of this repository, so the guest build can
# run in CI without a checkout of the Wau OS sources. The download is
# verified against the digest in guest-build/wau-os.lock.json, which is the
# same digest the guest build spec records, so a package that changed on the
# wire is rejected before it reaches the image.

set -euo pipefail

repo_root=$(cd "$(dirname "$0")/../.." && pwd)
lock=${TRYOMARCHY_WAU_OS_LOCK:-"$repo_root/guest-build/wau-os.lock.json"}
destination=${1:-}

if [[ -z $destination ]]; then
  echo "Usage: $0 DESTINATION_DIR" >&2
  exit 2
fi

readarray -t fields < <(python3 - "$lock" <<'PY'
import json
import pathlib
import sys

lock = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
entry = lock.get("package")
if not entry or set(entry) != {"url", "filename", "sha256"}:
    raise SystemExit("Wau OS lock must contain a package entry")
print(entry["url"])
print(entry["filename"])
print(entry["sha256"])
PY
)
(( ${#fields[@]} == 3 )) || { echo "Invalid Wau OS lock" >&2; exit 1; }

url=${fields[0]}
name=${fields[1]}
digest=${fields[2]}

[[ $name != */* && $name != .* ]] || { echo "Unsafe Wau OS package name: $name" >&2; exit 1; }
[[ $digest =~ ^[0-9a-f]{64}$ ]] || { echo "Invalid Wau OS package digest" >&2; exit 1; }

mkdir -p "$destination"
destination=$(cd "$destination" && pwd)
target="$destination/$name"

# The guest build refuses a symlink here, so the download always lands as a
# regular file.
curl --fail --location --retry 3 --output "$target" "$url"
printf '%s  %s\n' "$digest" "$target" | sha256sum --check

echo "$target"
