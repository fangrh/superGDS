"""Headless CLI for testing and debugging superGDS provenance logic.

Subcommands:
    parse <file.gds>              — parse and show summary
    click <file.gds> --at x,y    — select nearest feature
    click <file.gds> --index N   — select feature by index
    ctrl-a <file.gds> -i N -l 1  — simulate Ctrl+A grouping
    diagnose <file.gds>          — provenance health check
"""
from __future__ import annotations

import argparse
import json
import os
import pickle
import re
import sys

# Ensure sibling modules (parse_gds) are importable regardless of cwd.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


class GdsCache:
    """Pickle-based cache with mtime validation."""

    def __init__(self, gds_path: str) -> None:
        self._gds_path = gds_path
        base = re.sub(r"\.gds$", "", gds_path, flags=re.IGNORECASE)
        self._path = base + ".debug_cache.pkl"

    def load(self) -> dict | None:
        if not os.path.exists(self._path):
            return None
        try:
            with open(self._path, "rb") as f:
                cached = pickle.load(f)
            if cached.get("gds_mtime") == os.path.getmtime(self._gds_path):
                return cached.get("data")
        except Exception:
            pass
        return None

    def save(self, data: dict) -> None:
        with open(self._path, "wb") as f:
            pickle.dump({
                "gds_mtime": os.path.getmtime(self._gds_path),
                "data": data,
            }, f)


class GdsSession:
    """Parsed GDS state with query operations."""

    def __init__(self, gds_path: str, use_cache: bool = True) -> None:
        self.gds_path = gds_path
        self.features: list[dict] = []
        self.bbox: list | None = None
        self._cache_hit = False
        self._cache = GdsCache(gds_path) if use_cache else None

    def parse(self) -> GdsSession:
        if self._cache:
            cached = self._cache.load()
            if cached is not None:
                self.features = cached.get("features", [])
                self.bbox = cached.get("bbox")
                self._cache_hit = True
                return self

        from parse_gds import parse_gds
        result = parse_gds(self.gds_path)
        self.features = result.get("features", [])
        self.bbox = result.get("bbox")
        self._cache_hit = False

        if self._cache:
            self._cache.save({"features": self.features, "bbox": self.bbox})
        return self

    def parse_summary(self) -> dict:
        layers = []
        seen = set()
        for f in self.features:
            key = f.get("properties", {}).get("layer", "")
            if key not in seen:
                seen.add(key)
                layers.append(key)
        return {
            "features": len(self.features),
            "layers": layers,
            "bbox": self.bbox,
        }


def _cmd_parse(args) -> dict:
    session = GdsSession(args.gds, use_cache=not args.no_cache)
    session.parse()
    summary = session.parse_summary()
    summary["status"] = "ok"
    summary["cache"] = "hit" if session._cache_hit else "miss"
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description="superGDS headless debug CLI")
    parser.add_argument("--no-cache", action="store_true", help="Force re-parse")
    parser.add_argument("--verbose", action="store_true", help="Human-readable output")
    sub = parser.add_subparsers(dest="command")

    p_parse = sub.add_parser("parse", help="Parse GDS and show summary")
    p_parse.add_argument("gds", help="Path to .gds file")

    p_click = sub.add_parser("click", help="Select feature by coordinates or index")
    p_click.add_argument("gds", help="Path to .gds file")
    p_click.add_argument("--at", help="Click at x,y coordinates")
    p_click.add_argument("--index", type=int, help="Select feature by index")

    p_ctrl = sub.add_parser("ctrl-a", help="Simulate Ctrl+A grouping")
    p_ctrl.add_argument("gds", help="Path to .gds file")
    p_ctrl.add_argument("-i", "--index", type=int, required=True, help="Anchor feature index")
    p_ctrl.add_argument("-l", "--level", type=int, required=True, choices=[1, 2], help="Grouping level (1=L1, 2=L2)")

    p_diag = sub.add_parser("diagnose", help="Provenance health check")
    p_diag.add_argument("gds", help="Path to .gds file")

    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        sys.exit(1)

    try:
        handlers = {"parse": _cmd_parse}
        result = handlers[args.command](args)
    except Exception as e:
        result = {"status": "error", "message": str(e)}

    print(json.dumps(result, indent=2 if args.verbose else None))


if __name__ == "__main__":
    main()
