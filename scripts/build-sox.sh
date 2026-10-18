#!/usr/bin/env bash
# Builds the SoX with DSD support (Måns Rullgård's sox-dsd fork) that ships with the app
# as a separate program, for PCM -> DSD (DSF) conversion with its sigma-delta modulator
# (the `sdm` effect). No external libraries: the app feeds it WAV on stdin and it writes
# DSF. The sox program is GPL; its library files (including the DSD code) are LGPL.
# The download is pinned by SHA-256.
#
#   scripts/build-sox.sh [work-dir]
#
# Runs on macOS (Xcode command line tools, autoconf, automake, libtool), Linux (gcc,
# make, autoconf, automake, libtool) and Windows in an MSYS2 UCRT64 shell (gcc, make,
# autoconf, automake, libtool).
#
# Prints the paths to the built sox and its license text on the last two lines
# (Windows paths on Windows):
#   SOX_BUNDLE_SOURCE=<path>
#   SOX_BUNDLE_LICENSE=<path>
set -euo pipefail

case "$(uname -s)" in
  Darwin) OS=macos ;;
  Linux) OS=linux ;;
  MINGW*|MSYS*|CYGWIN*) OS=windows ;;
  *) echo "unsupported system: $(uname -s)" >&2; exit 1 ;;
esac

WORK="${1:-$PWD/build/sox}"
SRC="$WORK/src"
JOBS="$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)"
export MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-11.0}"

sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }
native_path() { if [ "$OS" = windows ]; then cygpath -m "$1"; else echo "$1"; fi; }

COMMIT=0be259eaa9ce3f3fa587a3ef0cf2c0b9c73167a2
NAME="sox-dsd-$COMMIT.tar.gz"
URL="https://github.com/mansr/sox/archive/$COMMIT.tar.gz"
SHA=795e90314462e4b0f028d731c748d52aa95391688a09c5ef9752d1cddb5b8072

EXE=""; [ "$OS" = windows ] && EXE=".exe"
BIN="$WORK/out/bin/sox$EXE"
LICENSE="$WORK/out/SOX-LICENSE.txt"
STAMP="$WORK/out/.built-by"
SCRIPT_HASH="$(sha256 "$0")"
done_message() {
  echo "SOX_BUNDLE_SOURCE=$(native_path "$BIN")"
  echo "SOX_BUNDLE_LICENSE=$(native_path "$LICENSE")"
}
# Reuse a previous build made by this exact script (e.g. restored from the CI cache).
if [ -x "$BIN" ] && [ -f "$LICENSE" ] && [ "$(cat "$STAMP" 2>/dev/null)" = "$SCRIPT_HASH" ]; then
  done_message
  exit 0
fi

# pkg-config's autoconf macros (PKG_CHECK_MODULES) must be installed for autoreconf.
for tool in autoreconf automake make pkg-config; do
  command -v "$tool" >/dev/null || { echo "$tool is required" >&2; exit 1; }
done

mkdir -p "$SRC"
cd "$SRC"
if [ ! -f "$NAME" ] || [ "$(sha256 "$NAME")" != "$SHA" ]; then
  curl -fsSL --retry 3 -o "$NAME" "$URL"
fi
[ "$(sha256 "$NAME")" = "$SHA" ] || { echo "checksum mismatch: $NAME" >&2; exit 1; }
rm -rf sox
mkdir sox
tar -xzf "$NAME" -C sox --strip-components=1
cd sox

autoreconf -i >/dev/null 2>&1 || autoreconf -i

# Only the built-in formats (WAV in, DSF out) and effects are needed: every optional
# library and audio device is off, so the program needs nothing outside the OS.
OFF=(
  magic png ladspa mad id3tag lame twolame oggvorbis opus flac amrwb amrnb wavpack
  sndio coreaudio alsa ao pulseaudio waveaudio sndfile oss sunaudio mp3 gsm lpc10 libltdl
)
FLAGS=(--disable-shared --enable-static --disable-openmp --disable-symlinks)
for lib in "${OFF[@]}"; do FLAGS+=("--without-$lib"); done
# Old code on new compilers: implicit declarations are errors by default since GCC 14 /
# Apple clang 16.
export CFLAGS="${CFLAGS:-} -O2 -Wno-implicit-function-declaration -Wno-int-conversion -Wno-incompatible-pointer-types"
LDFLAGS_EXTRA=()
[ "$OS" = windows ] && LDFLAGS_EXTRA=(LDFLAGS="-static")
./configure "${FLAGS[@]}" ${LDFLAGS_EXTRA[@]+"${LDFLAGS_EXTRA[@]}"} >/dev/null || { tail -n 40 config.log >&2; exit 1; }
# The 2017 sources print many warnings with current compilers: keep them in a log.
make -j"$JOBS" >make.log 2>&1 || { tail -n 60 make.log >&2; exit 1; }

mkdir -p "$WORK/out/bin"
cp "src/sox$EXE" "$BIN"
strip "$BIN" 2>/dev/null || true

{
  echo "This application includes the SoX program built from Måns Rullgård's sox-dsd"
  echo "fork, which adds DSD (DSF / DFF) support and the 'sdm' sigma-delta modulator."
  echo "It runs as a separate program."
  echo
  echo "Source: https://github.com/mansr/sox (commit $COMMIT)"
  echo "Archive: $URL"
  echo
  echo "Built without any optional libraries, with:"
  echo "  ./configure ${FLAGS[*]}"
  echo
  echo "The sox program (src/sox.c) is licensed under the GNU General Public License"
  echo "version 2 or later; the library files, including the DSD support (src/sdm.c,"
  echo "src/dsf.c, src/dff.c), are licensed under the GNU Lesser General Public License"
  echo "version 2.1 or later. The complete corresponding source is the archive above."
  echo
  echo "=================================== COPYING ==================================="
  cat COPYING
  echo
  echo "================================== LICENSE.GPL =================================="
  cat LICENSE.GPL
  echo
  echo "================================= LICENSE.LGPL =================================="
  cat LICENSE.LGPL
} > "$LICENSE"

echo "$SCRIPT_HASH" > "$STAMP"
done_message
