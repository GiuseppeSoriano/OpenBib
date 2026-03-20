from __future__ import annotations

import argparse
from pathlib import Path

from reference_manager.server import create_server


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the Reference Manager application.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--db", default=str(Path("data") / "reference_manager.sqlite3"))
    parser.add_argument("--static-dir", default=str(Path("static")))
    args = parser.parse_args()

    server = create_server(args.host, args.port, db_path=args.db, static_dir=args.static_dir)
    print(f"Reference Manager running on http://{args.host}:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
