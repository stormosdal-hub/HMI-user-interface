"""Start the editor:  python3 -B -m app  [--host 0.0.0.0] [--port 8000]"""

import argparse
import logging
import socket

from .server import create_app


def main():
    parser = argparse.ArgumentParser(description="LCD-editoren: skjermbilder til displayer på Pi-en, med taggene fra huben")
    parser.add_argument("--host")
    parser.add_argument("--port", type=int)
    parser.add_argument("--debug", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(level=logging.DEBUG if args.debug else logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    logging.getLogger("werkzeug").setLevel(logging.WARNING)

    app, config = create_app()
    host = args.host or config["server"]["host"]
    port = args.port or config["server"]["port"]
    logging.info("LCD-editoren kjører på http://%s:%s, taggene fra %s", socket.gethostname(), port,
                 config["hub"].get("url") or "ingen hub")
    app.run(host=host, port=port, threaded=True, use_reloader=False)


if __name__ == "__main__":
    main()
