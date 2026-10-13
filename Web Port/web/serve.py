#!/usr/bin/env python3
"""Local web server for the demo.

Sends the Cross-Origin-Opener-Policy / Cross-Origin-Embedder-Policy headers that browsers
require before they enable SharedArrayBuffer, which the multithreaded engine build needs.
Without them the demo falls back to the single-threaded build.

Usage: python3 serve.py [port]   (default port 8000), then open http://localhost:8000
"""
import http.server
import os
import sys


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".wasm": "application/wasm",
    }

    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


if __name__ == "__main__":
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    print(f"Serving on http://localhost:{port}")
    http.server.ThreadingHTTPServer(("", port), Handler).serve_forever()
