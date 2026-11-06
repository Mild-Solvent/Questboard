#!/usr/bin/env sh
# Copies the shared look (styles, effects, sounds, fonts) from the desktop renderer
# into the Android web assets, so both apps keep the same Tavern/Abyss themes.
# merge.js (parse/serialize/three-way merge) is shared too. app.js / index.html / mobile.css /
# bridge.js / sync.js are Android-specific.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
src="$here/../../src/renderer"
assets="$here/../../assets"
www="$here/../app/src/main/assets/www"
mkdir -p "$www/fonts"
cp "$src/styles.css" "$src/fx.js" "$src/sound.js" "$src/merge.js" "$www/"
sed 's#\.\./\.\./assets/fonts/#fonts/#g' "$src/fonts.css" > "$www/fonts.css"
cp "$assets"/fonts/*.woff2 "$www/fonts/"
echo "synced renderer from $src"
