#!/usr/bin/env bash
# Builds a redistributable (LGPL v2.1+) audio-only FFmpeg from source, with LAME (MP3),
# Opus, Vorbis and the SoX resampler (soxr) linked statically, so the binary needs nothing outside the OS.
# Every download is pinned by SHA-256.
#
#   scripts/build-ffmpeg.sh [work-dir]
#
# Runs on macOS (Xcode command line tools, cmake), Linux (gcc, make, cmake, nasm on
# x86_64, zlib headers) and Windows in an MSYS2 UCRT64 shell (gcc, make, cmake, nasm,
# pkgconf, zlib).
#
# Prints the paths to the built ffmpeg and its license text on the last two lines
# (Windows paths on Windows):
#   FFMPEG_BUNDLE_SOURCE=<path>
#   FFMPEG_BUNDLE_LICENSE=<path>
set -euo pipefail

case "$(uname -s)" in
  Darwin) OS=macos ;;
  Linux) OS=linux ;;
  MINGW*|MSYS*|CYGWIN*) OS=windows ;;
  *) echo "unsupported system: $(uname -s)" >&2; exit 1 ;;
esac
ARCH="$(uname -m)"

WORK="${1:-$PWD/build/ffmpeg}"
PREFIX="$WORK/prefix"
SRC="$WORK/src"
JOBS="$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)"
export MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-11.0}"

sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }
native_path() { if [ "$OS" = windows ]; then cygpath -m "$1"; else echo "$1"; fi; }

# name url sha256
SOURCES=(
  "libogg-1.3.5.tar.gz https://downloads.xiph.org/releases/ogg/libogg-1.3.5.tar.gz 0eb4b4b9420a0f51db142ba3f9c64b333f826532dc0f48c6410ae51f4799b664"
  "libvorbis-1.3.7.tar.gz https://downloads.xiph.org/releases/vorbis/libvorbis-1.3.7.tar.gz 0e982409a9c3fc82ee06e08205b1355e5c6aa4c36bca58146ef399621b0ce5ab"
  "opus-1.5.2.tar.gz https://downloads.xiph.org/releases/opus/opus-1.5.2.tar.gz 65c1d2f78b9f2fb20082c38cbe47c951ad5839345876e46941612ee87f9a7ce1"
  "soxr-0.1.3-Source.tar.xz https://downloads.sourceforge.net/project/soxr/soxr-0.1.3-Source.tar.xz b111c15fdc8c029989330ff559184198c161100a59312f5dc19ddeb9b5a15889"
  "lame-3.100.tar.gz https://downloads.sourceforge.net/project/lame/lame/3.100/lame-3.100.tar.gz ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e"
  "ffmpeg-7.1.1.tar.xz https://ffmpeg.org/releases/ffmpeg-7.1.1.tar.xz 733984395e0dbbe5c046abda2dc49a5544e7e0e1e2366bba849222ae9e3a03b1"
)

EXE=""; [ "$OS" = windows ] && EXE=".exe"
BIN="$WORK/out/bin/ffmpeg$EXE"
LICENSE="$WORK/out/FFMPEG-LICENSE.txt"
STAMP="$WORK/out/.built-by"
SCRIPT_HASH="$(sha256 "$0")"
done_message() {
  echo "FFMPEG_BUNDLE_SOURCE=$(native_path "$BIN")"
  echo "FFMPEG_BUNDLE_LICENSE=$(native_path "$LICENSE")"
}
# Reuse a previous build made by this exact script (e.g. restored from the CI cache).
if [ -x "$BIN" ] && [ -f "$LICENSE" ] && [ "$(cat "$STAMP" 2>/dev/null)" = "$SCRIPT_HASH" ]; then
  done_message
  exit 0
fi

# FFmpeg's x86 assembly (most of its speed on Intel/AMD) needs nasm.
if [ "$ARCH" = x86_64 ] && ! command -v nasm >/dev/null; then
  echo "nasm is required on x86_64 (brew/apt/pacman install nasm)" >&2
  exit 1
fi
command -v cmake >/dev/null || { echo "cmake is required (for soxr)" >&2; exit 1; }

mkdir -p "$SRC" "$PREFIX"
cd "$SRC"
for entry in "${SOURCES[@]}"; do
  read -r name url sha <<<"$entry"
  if [ ! -f "$name" ] || [ "$(sha256 "$name")" != "$sha" ]; then
    curl -fsSL --retry 3 -o "$name" "$url"
  fi
  [ "$(sha256 "$name")" = "$sha" ] || { echo "checksum mismatch: $name" >&2; exit 1; }
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
sed -i.orig 's/-force_cpusubtype_ALL//g' "$SRC/libvorbis-1.3.7/configure"
static_lib libvorbis-1.3.7 --with-ogg="$PREFIX"
static_lib opus-1.5.2 --disable-doc --disable-extra-programs
# lame 3.100 exports a symbol it does not define; drop it so linkers accept the list.
sed -i.orig '/lame_init_old/d' "$SRC/lame-3.100/include/libmp3lame.sym"
static_lib lame-3.100 --disable-frontend --disable-decoder
# soxr 0.1.3 asks for an old CMake; CMAKE_POLICY_VERSION_MINIMUM lets CMake 4 accept it.
GENERATOR="Unix Makefiles"; [ "$OS" = windows ] && GENERATOR="MSYS Makefiles"
cmake -S "$SRC/soxr-0.1.3-Source" -B "$SRC/soxr-build" -G "$GENERATOR" \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$PREFIX" -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
  -DBUILD_SHARED_LIBS=OFF -DBUILD_TESTS=OFF -DBUILD_EXAMPLES=OFF -DWITH_OPENMP=OFF -DWITH_LSR_BINDINGS=OFF >/dev/null
cmake --build "$SRC/soxr-build" -j "$JOBS" >/dev/null
cmake --install "$SRC/soxr-build" >/dev/null

# LGPL build: no --enable-gpl / --enable-nonfree. Only the OS and the static
# libraries above are linked; external libraries are not auto-detected.
EXTRA_LDFLAGS="-L$PREFIX/lib"
OS_FLAGS=(--enable-zlib)
case "$OS" in
  macos) OS_FLAGS+=(--enable-audiotoolbox --enable-bzlib) ;;
  windows) EXTRA_LDFLAGS="$EXTRA_LDFLAGS -static" ;; # no libgcc / winpthread DLLs
esac

cd "$SRC/ffmpeg-7.1.1"
./configure \
  --prefix="$WORK/out" \
  --pkg-config-flags=--static \
  --extra-cflags="-I$PREFIX/include" \
  --extra-ldflags="$EXTRA_LDFLAGS" \
  --disable-autodetect \
  "${OS_FLAGS[@]}" \
  --enable-libmp3lame \
  --enable-libopus \
  --enable-libvorbis \
  --enable-libsoxr \
  --disable-ffplay \
  --disable-ffprobe \
  --disable-doc \
  --disable-network \
  --disable-debug >/dev/null || { tail -n 40 ffbuild/config.log >&2; exit 1; }
make -j"$JOBS" >/dev/null
make install >/dev/null

# Must not depend on anything outside the OS.
case "$OS" in
  macos)
    if otool -L "$BIN" | tail -n +2 | grep -vE '^\s*(/usr/lib/|/System/Library/)'; then
      echo "unexpected dynamic dependency" >&2; exit 1
    fi ;;
  linux)
    # glibc and zlib are present on every desktop Linux.
    if ldd "$BIN" | grep -vE '^\s*(linux-vdso|/lib.*/ld-linux|lib(c|m|z|pthread|dl|rt|mvec)\.so)'; then
      echo "unexpected dynamic dependency" >&2; exit 1
    fi ;;
  windows)
    # Only Windows system DLLs (no lib*.dll from MinGW, no zlib1.dll).
    if objdump -p "$BIN" | sed -n 's/^\s*DLL Name: //p' | grep -iE '^(lib|zlib)'; then
      echo "unexpected dynamic dependency" >&2; exit 1
    fi ;;
esac
"$BIN" -hide_banner -version | head -n 1

{
  echo "FFmpeg 7.1.1 built from https://ffmpeg.org/releases/ffmpeg-7.1.1.tar.xz (LGPL v2.1 or later)."
  echo "Statically linked: LAME 3.100 (LGPL), soxr 0.1.3 (LGPL), Opus 1.5.2 (BSD), libvorbis 1.3.7 / libogg 1.3.5 (BSD)."
  echo "Build script: scripts/build-ffmpeg.sh in the application source repository."
  echo
  cat COPYING.LGPLv2.1
  for f in "$SRC/lame-3.100/COPYING" "$SRC/soxr-0.1.3-Source/LICENCE" "$SRC/opus-1.5.2/COPYING" "$SRC/libvorbis-1.3.7/COPYING" "$SRC/libogg-1.3.5/COPYING"; do
    echo; echo "---- $(basename "$(dirname "$f")") ----"; cat "$f"
  done
} >"$LICENSE"
echo "$SCRIPT_HASH" >"$STAMP"
done_message
