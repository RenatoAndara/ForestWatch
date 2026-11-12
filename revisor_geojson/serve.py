#!/usr/bin/env python3
"""
Servidor local del Revisor GeoJSON.

Autor: Renato Andara

Sirve la aplicación SOLO en este equipo (127.0.0.1) y abre el navegador.
Uso:
    python serve.py                 # puerto 8000 (o el siguiente libre)
    python serve.py --port 9000
    python serve.py --no-browser
"""

import argparse
import http.server
import os
import socketserver
import sys
import webbrowser

DIRECTORY = os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".geojson": "application/geo+json",
        ".js": "text/javascript",
        ".json": "application/json",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def log_message(self, fmt, *args):  # registro más discreto
        sys.stderr.write("  %s\n" % (fmt % args))


class ReusableServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def start_server(port: int = 8000, open_browser: bool = True, host: str = "127.0.0.1") -> None:
    for candidate in range(port, port + 11):
        try:
            httpd = ReusableServer((host, candidate), Handler)
        except OSError:
            print(f"Puerto {candidate} ocupado, probando {candidate + 1}…")
            continue
        with httpd:
            url = f"http://localhost:{candidate}"
            print("=" * 65)
            print("🚀 Revisor GeoJSON en ejecución")
            print(f"🌐 {url}   (solo accesible desde este equipo)")
            print(f"📂 {DIRECTORY}")
            print("Presiona Ctrl+C para detener.")
            print("=" * 65)
            if open_browser:
                webbrowser.open(url)
            try:
                httpd.serve_forever()
            except KeyboardInterrupt:
                print("\n🛑 Servidor detenido.")
            return
    print(f"❌ No hay puertos libres entre {port} y {port + 10}.")
    sys.exit(1)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Servidor local del Revisor GeoJSON")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--no-browser", action="store_true", help="No abrir el navegador automáticamente")
    args = parser.parse_args()
    start_server(args.port, not args.no_browser)
