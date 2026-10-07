# Lokaler Entwicklungsserver ohne Browser-Cache, damit Änderungen sofort sichtbar sind.
# Liefert immer den Projektordner aus, egal aus welchem Verzeichnis er gestartet wird.
# Aufruf: python tools/serve.py [port]
import functools
import http.server
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


port = int(sys.argv[1]) if len(sys.argv) > 1 else 5173
handler = functools.partial(NoCacheHandler, directory=str(ROOT))
http.server.ThreadingHTTPServer(("127.0.0.1", port), handler).serve_forever()
