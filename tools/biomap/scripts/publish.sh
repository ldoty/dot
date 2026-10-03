#!/usr/bin/env bash
# Publish the collection for the app: build the deck, shrink photos for the web, and sync both
# to the private biomap bucket (read only through the signed-in API).
#   tools/biomap/scripts/publish.sh
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
export AWS_PROFILE="${AWS_PROFILE:-ldoty}" AWS_REGION=us-east-1
bucket=$(tofu -chdir="$here/infra" output -raw collection_bucket)

python3 "$here/scripts/build.py"

# Photos the deck uses, downscaled (1600px, JPEG) into .build/photos/ under the same paths
python3 - "$here" <<'PY'
import json, os, subprocess, sys
here = sys.argv[1]
deck = json.load(open(os.path.join(here, ".build/deck.json")))
for t in deck["taxa"]:
    p = t.get("image_path")
    if not p:
        continue
    src = os.path.join(here, "collection", p)
    dst = os.path.join(here, ".build/photos", p)
    if os.path.exists(dst) and os.path.getmtime(dst) >= os.path.getmtime(src):
        continue
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    subprocess.run(["sips", "-Z", "1600", "-s", "format", "jpeg", "-s", "formatOptions", "72", src, "--out", dst],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print("  photo", p)
PY

aws s3 sync "$here/.build/photos/" "s3://$bucket/photos/" --delete --only-show-errors
aws s3 cp "$here/.build/deck.json" "s3://$bucket/deck.json" --content-type application/json --only-show-errors
echo "Published deck and photos to s3://$bucket"
