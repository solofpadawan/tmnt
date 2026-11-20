#!/bin/bash
# Build the public Windows x64 desktop app.
# ROM is NOT included — the in-game loader asks for the user's own MAME tmnt.zip.
# Online multiplayer is removed from the packaged UI (web/net is not copied).
set -euo pipefail
cd "$(dirname "$0")"
STAMP=${STAMP:-$(date +%Y%m%d-%H%M%S)}
NAME=${NAME:-TMNT-win64-$STAMP}
rm -rf web out
mkdir web
python3 - <<'PY'
import os, re, shutil
from pathlib import Path
src = Path('../web')
dst = Path('web')
skip_dirs = {'roms', 'net', 'img'}
skip_suffix = {'.php', '.bak', '.zip'}
for root, dirs, files in os.walk(src):
    rel = Path(root).relative_to(src)
    dirs[:] = [d for d in dirs if d not in skip_dirs and not d.startswith('.')]
    if rel.parts and rel.parts[0] in skip_dirs:
        continue
    (dst / rel).mkdir(parents=True, exist_ok=True)
    for fn in files:
        if Path(fn).suffix.lower() in skip_suffix:
            continue
        shutil.copy2(Path(root) / fn, dst / rel / fn)
html = Path('web/index.html')
t = html.read_text(encoding='utf-8')
t = re.sub(r'<script src="net/[^"]+"></script>', '', t)
t = t.replace(' · F7 online · TAB chat', '')
# Mark this tree as the public (ROM-not-bundled) build.
t = t.replace('window.TMNTV_STAMP =', 'window.TMNT_PUBLIC = 1; window.TMNTV_STAMP =')
html.write_text(t, encoding='utf-8')
PY
if [ -d web/net ]; then echo "web/net must not be present in the desktop build" >&2; exit 1; fi
if [ -e web/roms/tmnt.zip ]; then echo "ROM must not be bundled in the public build" >&2; exit 1; fi
if find web -iname '*.zip' | grep -q .; then echo "refuse: zip leaked into desktop web/" >&2; exit 1; fi
if grep -R -E -q 'games4me-netplay|alwaysdata|peerjs.com|/scores/report' web --include='*.js' --include='*.html' --include='*.css'; then
  echo "web/ still contains online endpoints" >&2; exit 1
fi
rm -rf out
npx @electron/packager . TMNT --platform=win32 --arch=x64 --out=out --icon=icon.ico --asar --extra-resource=web \
  --ignore='^/web' --ignore='^/out' --ignore='\.gitignore' --ignore='build\.sh' \
  --win32metadata.ProductName="TMNT" --win32metadata.FileDescription="TMNT arcade HTML5 remake"
mv out/TMNT-win32-x64 out/TMNT
mkdir -p ../dist/desktop
(cd out && python3 -c "import shutil,sys; shutil.make_archive('../../dist/desktop/' + sys.argv[1], 'zip', '.', 'TMNT')" "$NAME")
echo "ZIP ../dist/desktop/$NAME.zip"
