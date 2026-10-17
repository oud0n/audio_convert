#!/usr/bin/env bash
# Builds a redistributable (LGPL v2.1+) audio FFmpeg for macOS from source, with
# LAME (MP3), Opus and Vorbis linked statically, so the binary runs on any Mac
# without Homebrew. Every download is pinned by SHA-256.
#
#   scripts/build-ffmpeg-macos.sh [work-dir]
#
# Prints the paths to the built ffmpeg and its license text on the last two lines:
#   FFMPEG_BUNDLE_SOURCE=<path>
#   FFMPEG_BUNDLE_LICENSE=<path>
set -euo pipefail

WORK="${1:-$PWD/build/ffmpeg-macos}"
PREFIX="$WORK/prefix"
SRC="$WORK/src"
JOBS="$(sysctl -n hw.ncpu 2>/dev/null || echo 4)"
export MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-11.0}"

# name url sha256
SOURCES=(
  "libogg-1.3.5.tar.gz https://downloads.xiph.org/releases/ogg/libogg-1.3.5.tar.gz 0eb4b4b9420a0f51db142ba3f9c64b333f826532dc0f48c6410ae51f4799b664"
  "libvorbis-1.3.7.tar.gz https://downloads.xiph.org/releases/vorbis/libvorbis-1.3.7.tar.gz 0e982409a9c3fc82ee06e08205b1355e5c6aa4c36bca58146ef399621b0ce5ab"
  "opus-1.5.2.tar.gz https://downloads.xiph.org/releases/opus/opus-1.5.2.tar.gz 65c1d2f78b9f2fb20082c38cbe47c951ad5839345876e46941612ee87f9a7ce1"
  "lame-3.100.tar.gz https://downloads.sourceforge.net/project/lame/lame/3.100/lame-3.100.tar.gz ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e"
  "ffmpeg-7.1.1.tar.xz https://ffmpeg.org/releases/ffmpeg-7.1.1.tar.xz 733984395e0dbbe5c046abda2dc49a5544e7e0e1e2366bba849222ae9e3a03b1"
)

BIN="$WORK/out/bin/ffmpeg"
LICENSE="$WORK/out/FFMPEG-LICENSE.txt"
STAMP="$WORK/out/.built-by"
SCRIPT_HASH="$(shasum -a 256 "$0" | cut -d' ' -f1)"
# Reuse a previous build made by this exact script (e.g. restored from the CI cache).
if [ -x "$BIN" ] && [ -f "$LICENSE" ] && [ "$(cat "$STAMP" 2>/dev/null)" = "$SCRIPT_HASH" ]; then
  echo "FFMPEG_BUNDLE_SOURCE=$BIN"
  echo "FFMPEG_BUNDLE_LICENSE=$LICENSE"
  exit 0
fi

# FFmpeg's x86 assembly (most of its speed on Intel) needs nasm.
if [ "$(uname -m)" = "x86_64" ] && ! command -v nasm >/dev/null; then
  echo "nasm is required on Intel Macs (brew install nasm)" >&2
  exit 1
fi

mkdir -p "$SRC" "$PREFIX"
cd "$SRC"
for entry in "${SOURCES[@]}"; do
  read -r name url sha <<<"$entry"
  if [ ! -f "$name" ] || ! echo "$sha  $name" | shasum -a 256 -c - >/dev/null 2>&1; then
    curl -fsSL --retry 3 -o "$name" "$url"
  fi
  echo "$sha  $name" | shasum -a 256 -c - >/dev/null || { echo "checksum mismatch: $name" >&2; exit 1; }
  dir="${name%.tar.*}"
  rm -rf "$dir"
  tar -xf "$name"
done

static_lib() { # dir [configure args...]
  local dir="$1"; shift
  (cd "$SRC/$dir" && ./configure --prefix="$PREFIX" --disable-shared --enable-static "$@" >/dev/null && make -j"$JOBS" >/dev/null && make install >/dev/null)
}

export PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig"
static_lib libogg-1.3.5
# libvorbis 1.3.7 passes -force_cpusubtype_ALL, which current Apple linkers reject.
sed -i '' 's/-force_cpusubtype_ALL//g' "$SRC/libvorbis-1.3.7/configure"
static_lib libvorbis-1.3.7 --with-ogg="$PREFIX"
static_lib opus-1.5.2 --disable-doc --disable-extra-programs
# lame 3.100 exports a symbol it does not define; drop it so the macOS linker accepts the list.
sed -i '' '/lame_init_old/d' "$SRC/lame-3.100/include/libmp3lame.sym"
static_lib lame-3.100 --disable-frontend --disable-decoder

cd "$SRC/ffmpeg-7.1.1"
# LGPL build: no --enable-gpl / --enable-nonfree. Only the system frameworks and the
# static libraries above are linked; external libraries are not auto-detected.
./configure \
  --prefix="$WORK/out" \
  --pkg-config-flags=--static \
  --extra-cflags="-I$PREFIX/include" \
  --extra-ldflags="-L$PREFIX/lib" \
  --disable-autodetect \
  --enable-audiotoolbox \
  --enable-zlib \
  --enable-bzlib \
  --enable-libmp3lame \
  --enable-libopus \
  --enable-libvorbis \
  --disable-ffplay \
  --disable-ffprobe \
  --disable-doc \
  --disable-network \
  --disable-debug >/dev/null
make -j"$JOBS" >/dev/null
make install >/dev/null

# Must not depend on anything outside the OS.
if otool -L "$BIN" | tail -n +2 | grep -vE '^\s*(/usr/lib/|/System/Library/)'; then
  echo "unexpected dynamic dependency" >&2
  exit 1
fi
{
  echo "FFmpeg 7.1.1 built from https://ffmpeg.org/releases/ffmpeg-7.1.1.tar.xz (LGPL v2.1 or later)."
  echo "Statically linked: LAME 3.100 (LGPL), Opus 1.5.2 (BSD), libvorbis 1.3.7 / libogg 1.3.5 (BSD)."
  echo "Build script: scripts/build-ffmpeg-macos.sh in the application source repository."
  echo
  cat COPYING.LGPLv2.1
  for f in "$SRC/lame-3.100/COPYING" "$SRC/opus-1.5.2/COPYING" "$SRC/libvorbis-1.3.7/COPYING" "$SRC/libogg-1.3.5/COPYING"; do
    echo; echo "---- $(basename "$(dirname "$f")") ----"; cat "$f"
  done
} >"$LICENSE"
echo "$SCRIPT_HASH" >"$STAMP"

echo "FFMPEG_BUNDLE_SOURCE=$BIN"
echo "FFMPEG_BUNDLE_LICENSE=$LICENSE"
