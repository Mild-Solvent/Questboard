#!/usr/bin/env bash
# Build the signed Android release APK on a Linux box (the devbox) and optionally upload it
# to a GitHub release. Idempotent: installs the Android SDK into ~/android-sdk when missing,
# creates the signing key in ~/questboard-signing when missing (and prints where it is).
#
#   android/tools/release.sh                 # build only -> android/app/build/outputs/apk/release/
#   android/tools/release.sh v0.3.0          # build and `gh release upload` the APK to that tag
#
# Needs: JDK 17+ (java/keytool), curl, unzip, python3. `gh` only for the upload step.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
android_dir="$(cd "$here/.." && pwd)"
tag="${1:-}"

export ANDROID_HOME="${ANDROID_HOME:-$HOME/android-sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
CMDLINE_ZIP="https://dl.google.com/android/repository/commandlinetools-linux-13114758_latest.zip"

java -version 2>&1 | head -1
if [ ! -x "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" ]; then
  echo "== installing Android command-line tools into $ANDROID_HOME"
  mkdir -p "$ANDROID_HOME/cmdline-tools"
  tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/ct.zip" "$CMDLINE_ZIP"
  unzip -q "$tmp/ct.zip" -d "$tmp"
  rm -rf "$ANDROID_HOME/cmdline-tools/latest"
  mv "$tmp/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest"
  rm -rf "$tmp"
fi
if [ ! -d "$ANDROID_HOME/platforms/android-35" ] || [ ! -d "$ANDROID_HOME/build-tools/35.0.0" ]; then
  echo "== installing platform 35 + build-tools 35"
  yes | "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$ANDROID_HOME" --licenses >/dev/null 2>&1 || true
  "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$ANDROID_HOME" "platform-tools" "platforms;android-35" "build-tools;35.0.0" >/dev/null
fi
echo "sdk.dir=$ANDROID_HOME" > "$android_dir/local.properties"

sign_dir="$HOME/questboard-signing"
# Key lookup order: env var, the project's private files folder (cloud sessions), ~/questboard-signing.
props="${QUESTBOARD_KEYSTORE_PROPS:-}"
[ -z "$props" ] && [ -f /mnt/project-files/questboard/signing/keystore.properties ] && props=/mnt/project-files/questboard/signing/keystore.properties
[ -z "$props" ] && props="$sign_dir/keystore.properties"
if [ ! -f "$props" ]; then
  echo "== creating signing key in $sign_dir (keep this folder; the same key must sign every release)"
  echo "   NOTE: the canonical key lives in the project's files at questboard/signing/; copy it here instead if you have it."
  mkdir -p "$sign_dir"; chmod 700 "$sign_dir"
  pass="$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')"
  keytool -genkeypair -v -keystore "$sign_dir/questboard.jks" -alias questboard -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass "$pass" -keypass "$pass" -dname "CN=Questboard, O=Mild-Solvent" >/dev/null 2>&1
  cat > "$props" <<EOF
storeFile=$sign_dir/questboard.jks
storePassword=$pass
keyAlias=questboard
keyPassword=$pass
EOF
  chmod 600 "$props" "$sign_dir/questboard.jks"
fi
export QUESTBOARD_KEYSTORE_PROPS="$props"

echo "== syncing shared renderer files"
"$here/sync-renderer.sh"

echo "== building release APK"
cd "$android_dir"
./gradlew --no-daemon -q --max-workers=1 -Dorg.gradle.internal.repository.max.tentatives=12 -Dorg.gradle.internal.repository.initial.backoff=3000 assembleRelease
apk="$(ls -t "$android_dir"/app/build/outputs/apk/release/Questboard-*-android.apk | head -1)"
"$ANDROID_HOME/build-tools/35.0.0/apksigner" verify --print-certs "$apk" | head -3
ls -la "$apk"

if [ -n "$tag" ]; then
  echo "== uploading to release $tag"
  gh release upload "$tag" "$apk" --repo Mild-Solvent/Questboard --clobber
  echo "https://github.com/Mild-Solvent/Questboard/releases/download/$tag/$(basename "$apk")"
fi
