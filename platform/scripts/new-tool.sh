#!/usr/bin/env bash
# Scaffold a new tool from platform/templates/tool:
#   platform/scripts/new-tool.sh recipes "Recipes" [group]
# Creates tools/recipes/ (site at recipes.dot-y.co, permission group family_recipes unless given),
# wired for sign-in, its own API + table, a home page tile, and tests.
set -euo pipefail
tool="${1:?usage: new-tool.sh NAME \"Title\" [GROUP]}"
title="${2:?usage: new-tool.sh NAME \"Title\" [GROUP]}"
[[ "$tool" =~ ^[a-z][a-z0-9-]{1,30}$ ]] || { echo "NAME must be lowercase letters, digits and - (it becomes NAME.dot-y.co)" >&2; exit 1; }
group="${3:-family_${tool//-/_}}"
[[ "$group" =~ ^[a-z][a-z0-9_-]*$ ]] || { echo "GROUP must be lowercase letters, digits, - and _" >&2; exit 1; }
root="$(cd "$(dirname "$0")/../.." && pwd)"
dest="$root/tools/$tool"
[[ -e "$dest" ]] && { echo "$dest already exists" >&2; exit 1; }

cp -R "$root/platform/templates/tool" "$dest"
for f in $(grep -rl "__TOOL__\|__GROUP__\|__TITLE__" "$dest"); do
  TOOL="$tool" GROUP="$group" TITLE="$title" perl -pi -e 's/__TOOL__/$ENV{TOOL}/g; s/__GROUP__/$ENV{GROUP}/g; s/__TITLE__/$ENV{TITLE}/g' "$f"
done
for f in "$dest"/tests/*__TOOL__*; do mv "$f" "${f//__TOOL__/$tool}"; done
ln -s ../../../platform/api/verify-token.mjs "$dest/api/verify-token.mjs"
rm -f "$dest/scripts/.gitkeep"

cat <<MSG
Created tools/$tool  (https://$tool.dot-y.co, group $group)

Next:
  npm test                                  # its unit tests run with everything else
  cd tools/$tool/infra && tofu init && tofu apply
  cd ../../../platform/core && tofu apply   # adds its tile to the home page
  platform/scripts/invite.sh EMAIL NAME $group   # or add existing users to $group
  npm run test:live
MSG
