#!/bin/sh
# PC deploy zip: web/ (minus net/rooms runtime data) + roms/tmnt.zip (local use only, never public). Stamps ?v= for cache busting.
set -e; cd "$(dirname "$0")/.."; S=$(date +%Y%m%d%H%M); T=$(mktemp -d)
cp -r web "$T/tmnt_web"; rm -rf "$T/tmnt_web/net/rooms"/*; mkdir -p "$T/tmnt_web/roms"; cp roms/tmnt.zip "$T/tmnt_web/roms/"
sed -i "s/v=[0-9a-z]*\"/v=$S\"/g; s/TMNTV_STAMP = \"[0-9a-z]*\"/TMNTV_STAMP = \"$S\"/" "$T/tmnt_web/index.html"
find "$T" -name __pycache__ -prune -exec rm -rf {} +
mkdir -p out; rm -f out/tmnt_pc.zip; python3 -c "import shutil,sys; shutil.make_archive(sys.argv[1], 'zip', sys.argv[2])" out/tmnt_pc "$T/tmnt_web"; rm -rf "$T"; echo "out/tmnt_pc.zip stamp $S"
