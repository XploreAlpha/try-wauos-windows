#!/usr/bin/env bash

set -euo pipefail

# The guest source tree is checked out on the host, and git derives directory
# permissions from the process umask. A permissive umask (0002 is common on
# shared workstations) turns every guest overlay directory into 0775, and the
# build copies those modes into the staged rootfs, where they then contradict
# the 0755 directory modes recorded in the Wau OS package's mtree. Pin the
# umask to the value the upstream CI uses so the image is reproducible.
umask 022

repo_root=$(cd "$(dirname "$0")/../.." && pwd)
output=""
contract_only=0
source_only=0
wau_os_package=""
refresh_package_lock=""
work_volume=""

while (($#)); do
  case "$1" in
    --output)
      output=${2:-}
      shift 2
      ;;
    --contract-only)
      contract_only=1
      shift
      ;;
    --source-only)
      source_only=1
      shift
      ;;
    --wau-os-package)
      wau_os_package=${2:-}
      shift 2
      ;;
    --refresh-package-lock)
      refresh_package_lock=${2:-}
      shift 2
      ;;
    --work-volume)
      work_volume=${2:-}
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if ((contract_only == 0)) && [[ -z $output && -z $refresh_package_lock ]]; then
  echo "Usage: $0 --output DIR [--contract-only | --source-only]" >&2
  echo "       $0 --refresh-package-lock FILE" >&2
  echo "       $0 --output DIR [--wau-os-package FILE] [--work-volume NAME]" >&2
  exit 2
fi

if [[ -n $wau_os_package ]]; then
  [[ -f $wau_os_package ]] || { echo "Wau OS package not found: $wau_os_package" >&2; exit 2; }
  wau_os_package=$(cd "$(dirname "$wau_os_package")" && pwd)/$(basename "$wau_os_package")
fi

source_lock="$repo_root/guest-build/source.lock.json"
readarray -t source_fields < <(python3 - "$source_lock" <<'PY'
import json
import pathlib
import sys

lock = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
print(lock["repository"])
print(lock["commit"])
PY
)
source_url=${source_fields[0]}
source_commit=${source_fields[1]}
[[ $source_commit =~ ^[0-9a-f]{40}$ ]] || { echo "Invalid guest source commit" >&2; exit 1; }

work=$(mktemp -d "${RUNNER_TEMP:-/tmp}/try-omarchy-guest-source.XXXXXX")
cleanup() {
  rm -rf -- "$work"
}
trap cleanup EXIT

git -C "$work" init --quiet
git -C "$work" remote add origin "$source_url"
git -C "$work" fetch --quiet --depth=1 origin "$source_commit"
git -C "$work" checkout --quiet --detach FETCH_HEAD
test "$(git -C "$work" rev-parse HEAD)" = "$source_commit"
git -C "$work" config user.name "Try Omarchy Release"
git -C "$work" config user.email "actions@users.noreply.github.com"
git -C "$work" am "$repo_root"/guest-build/*.patch

# The guest's package transaction is a reviewed, fully locked list. Changing
# the requested packages means the lock has to be resolved again, and the
# result is delivered as the next patch in guest-build/, like every other
# lock refresh in this repository.
if [[ -n $refresh_package_lock ]]; then
  lock_parent=$(dirname "$refresh_package_lock")
  mkdir -p "$lock_parent"
  lock_parent=$(cd "$lock_parent" && pwd)
  lock_file="$lock_parent/$(basename "$refresh_package_lock")"
  bash "$work/guest/build-container.sh" --refresh-package-lock "$lock_file"
  docker run --rm --platform linux/amd64 --entrypoint chown \
    -v "$lock_parent:/lock-output" try-omarchy-guest-builder \
    "$(id -u):$(id -g)" "/lock-output/$(basename -- "$lock_file")"
  install -m 0644 "$lock_file" "$work/guest/packages.lock.json"
  git -C "$work" add guest/packages.lock.json
  git -C "$work" commit --quiet -m "Refresh the guest package lock"
  highest=$(printf '%s\n' "$repo_root"/guest-build/*.patch |
    sed -n 's|.*/\([0-9][0-9]*\)-.*|\1|p' | LC_ALL=C sort -n | tail -1)
  highest=${highest:-0}
  next=$(printf '%04d' $((highest + 1)))
  patch_file="$repo_root/guest-build/$next-Refresh-the-guest-package-lock.patch"
  git -C "$work" format-patch -1 --stdout >"$patch_file"
  echo "Wrote $patch_file"
  exit 0
fi

# Export the patched builder without building an image or running its suites.
# The shell canary uses its own fetch, materialize and backport scripts.
if ((source_only)); then
  [[ -n $output && ! -e $output ]] || { echo "Source output must not exist" >&2; exit 2; }
  mkdir -p "$(dirname "$output")"
  mv -- "$work" "$output"
  exit 0
fi

# The guest carries the Try Omarchy importer from migrate/: try-omarchy-export
# runs it and packs it into every export. It is built here rather than kept in
# a patch so the guest and the release assets always ship the same code.
python3 "$repo_root/migrate/build.py" --version "${RELEASE_TAG:-dev}" --output "$work/importer" >/dev/null
install -Dm0755 "$work/importer/try-omarchy-import.pyz" \
  "$work/guest/factory-overlay/usr/local/lib/try-omarchy/try-omarchy-import.pyz"

"$work/guest/test"

if ((contract_only)); then
  exit 0
fi

mkdir -p "$output"
# Docker reads a relative path in -v as the name of a volume, not as a host
# directory, so the release artifacts have to be addressed absolutely.
output=$(cd "$output" && pwd)
# The builder drives the Docker daemon, which already runs the factory build
# as root inside the container. Reaching the daemon is all this step needs,
# and every account that installs Docker is expected to be in the docker
# group, so the script does not ask for sudo to do it.
bash "$work/guest/build-container.sh" --output "$output" \
  ${work_volume:+--work-volume "$work_volume"} \
  ${wau_os_package:+--wau-os-package "$wau_os_package"}
# The container build runs as root so it can create and mount the factory
# filesystem. Return the finished release artifacts to the workflow user before
# later steps extend SHA256SUMS and upload the files.
docker run --rm --platform linux/amd64 --entrypoint chown \
  -v "$output:/output" try-omarchy-guest-builder \
  -R -- "$(id -u):$(id -g)" /output
