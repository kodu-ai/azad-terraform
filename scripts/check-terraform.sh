#!/usr/bin/env bash
# Offline Terraform checks for every root, example and module: formatting,
# `init -backend=false` + `validate`, and `terraform test` where tests exist.
# Tests use mocked providers and plan-only runs, so no credentials or cloud
# resources are involved. CI runs exactly this; so can you.
#
# Usage: scripts/check-terraform.sh [directory...]   (default: all of them)
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
export TF_IN_AUTOMATION=1 TF_INPUT=0
export TF_PLUGIN_CACHE_DIR="${TF_PLUGIN_CACHE_DIR:-${TMPDIR:-/tmp}/azad-terraform-plugins}"
mkdir -p "$TF_PLUGIN_CACHE_DIR"

if [[ $# -gt 0 ]]; then
  directories=("$@")
else
  terraform fmt -check -recursive -diff
  directories=()
  while IFS= read -r directory; do directories+=("$directory"); done < <(
    find roots examples modules -name '*.tf' -not -path '*/.terraform/*' -exec dirname {} \; | sort -u
  )
fi

failed=()
for directory in "${directories[@]}"; do
  echo "::group::$directory"
  # Working data stays out of the tree, so checks never touch a real install.
  data="$(mktemp -d)"
  # A committed lock file is verified, never rewritten; modules keep none.
  lockfile=()
  [[ -f "$directory/.terraform.lock.hcl" ]] && lockfile=(-lockfile=readonly)
  if TF_DATA_DIR="$data" terraform -chdir="$directory" init -backend=false -input=false -no-color ${lockfile[@]+"${lockfile[@]}"} >"$data/init.log" 2>&1 &&
    TF_DATA_DIR="$data" terraform -chdir="$directory" validate -no-color &&
    { ! compgen -G "$directory/tests/*.tftest.hcl" >/dev/null || TF_DATA_DIR="$data" terraform -chdir="$directory" test -no-color; }; then
    :
  else
    [[ -f "$data/init.log" ]] && cat "$data/init.log"
    failed+=("$directory")
  fi
  rm -rf "$data"
  echo "::endgroup::"
done

if [[ ${#failed[@]} -gt 0 ]]; then
  echo "Terraform checks failed in: ${failed[*]}" >&2
  exit 1
fi
echo "Terraform checks passed in ${#directories[@]} directories."
