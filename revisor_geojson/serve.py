"""
Local HTTP Server for GeoJSON Integrity & Cartographic Inspector.
Serves the web application and automatically opens the user's default browser.
"""

import http.server
import socketserver
import webbrowser
import os
import sys

PORT = 8000
DIRECTORY = os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def end_headers(self):
        # Enable CORS and disable aggressive caching for local development
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        super().end_headers()


def start_server():
    global PORT
    for attempt in range(10):
        try:
            with socketserver.TCPServer(("", PORT), Handler) as httpd:
                url = f"http://localhost:{PORT}"
                print("=" * 65)
                print(f"🚀 Servidor del Validador GeoJSON iniciado exitosamente!")
                print(f"🌐 URL: {url}")
                print(f"📂 Directorio: {DIRECTORY}")
                print(f"Presiona Ctrl+C para detener el servidor.")
                print("=" * 65)
                
                # Open browser
                webbrowser.open(url)
                
                try:
                    httpd.serve_forever()
                except KeyboardInterrupt:
                    print("\n🛑 Servidor detenido por el usuario.")
                return
        except OSError:
            print(f"Puerto {PORT} ocupado, intentando con {PORT + 1}...")
            PORT += 1

    print("❌ No se pudo encontrar un puerto libre entre 8000 y 8010.")


if __name__ == "__main__":
    start_server()
