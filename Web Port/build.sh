#!/usr/bin/env bash
# Builds the BG raster engine to WebAssembly.
#
# Requires the Emscripten SDK (https://emscripten.org/docs/getting_started/downloads.html):
#   source /path/to/emsdk/emsdk_env.sh
#   ./build.sh
#
# Produces two builds in web/dist:
#   raster-mt.js/.wasm  multithreaded (pthreads -> Web Workers). Needs a cross-origin
#                       isolated page (COOP/COEP headers), see web/serve.py.
#   raster-st.js/.wasm  single-threaded fallback that runs on any static host.
set -euo pipefail
cd "$(dirname "$0")"

OUT=web/dist
mkdir -p "$OUT"

COMMON=(
  engine/WebApi.cpp
  -std=c++17 -O3 -ffast-math
  # The engine is written with AVX2 intrinsics; Emscripten translates them to 128-bit WASM SIMD.
  -msimd128 -mavx2
  -Wno-pragma-once-outside-header
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createRasterEngine
  -sENVIRONMENT=web,worker
  -sINITIAL_MEMORY=256MB
  -sEXPORTED_FUNCTIONS=_malloc,_free
  -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAP32,HEAPF32
)

echo "Building multithreaded engine..."
em++ "${COMMON[@]}" -pthread -sPTHREAD_POOL_SIZE=navigator.hardwareConcurrency -o "$OUT/raster-mt.js"

echo "Building single-threaded engine..."
em++ "${COMMON[@]}" -o "$OUT/raster-st.js"

ls -lh "$OUT"
