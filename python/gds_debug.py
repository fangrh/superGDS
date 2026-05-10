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
        except (pickle.UnpicklingError, EOFError, OSError, ValueError):
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

    def click(self, x: float, y: float) -> tuple[int | None, float]:
        """Find feature nearest to (x, y) by centroid distance."""
        best_idx = None
        best_dist = float("inf")
        for i, feat in enumerate(self.features):
            coords = feat.get("geometry", {}).get("coordinates", [[]])[0]
            if len(coords) < 3:
                continue
            n = len(coords) - 1  # last point duplicates first
            cx = sum(p[0] for p in coords[:n]) / n
            cy = sum(p[1] for p in coords[:n]) / n
            dist = ((cx - x) ** 2 + (cy - y) ** 2) ** 0.5
            if dist < best_dist:
                best_dist = dist
                best_idx = i
        return best_idx, best_dist if best_idx is not None else float("inf")

    def click_index(self, index: int) -> dict | None:
        """Return feature at given index, or None."""
        if 0 <= index < len(self.features):
            return self.features[index]
        return None

    @staticmethod
    def _instance_base(name: str) -> str:
        """Strip trailing _N suffix to get array identity."""
        return re.sub(r"_(\d+)$", "", name)

    def ctrl_a(self, anchor_index: int, level: int) -> dict | None:
        """Simulate Ctrl+A L1/L2 grouping.

        L1: group by instance_name base (strip _N suffix).
        L2: group by loop_index array equality.
        """
        if anchor_index < 0 or anchor_index >= len(self.features):
            return None

        anchor_prov = self.features[anchor_index].get("properties", {}).get("provenance", {})

        if level == 1:
            group_base = self._instance_base(anchor_prov.get("instance_name", ""))
            group = [
                i for i, f in enumerate(self.features)
                if self._instance_base(f.get("properties", {}).get("provenance", {}).get("instance_name", ""))
                == group_base
            ]
            return {
                "anchor_instance_base": group_base,
                "group_indices": group,
            }

        if level == 2:
            anchor_loop = anchor_prov.get("loop_index")
            group = []
            for i, f in enumerate(self.features):
                fp = f.get("properties", {}).get("provenance", {})
                fl = fp.get("loop_index")
                if not fl and not anchor_loop:
                    group.append(i)
                elif not fl or not anchor_loop:
                    continue
                elif len(fl) != len(anchor_loop):
                    continue
                elif all(v == anchor_loop[j] for j, v in enumerate(fl)):
                    group.append(i)
            return {
                "anchor_loop_index": anchor_loop,
                "group_indices": group,
            }

        return None


def _format_feature(index: int, feat: dict, distance: float | None = None) -> dict:
    """Extract the JSON output for a single feature."""
    props = feat.get("properties", {})
    result: dict = {
        "status": "ok",
        "index": index,
        "layer": props.get("layer", ""),
        "bbox": props.get("bbox", []),
        "provenance": props.get("provenance", {}),
    }
    if distance is not None:
        result["distance"] = round(distance, 4)
    return result


def _cmd_parse(args) -> dict:
    session = GdsSession(args.gds, use_cache=not args.no_cache)
    session.parse()
    summary = session.parse_summary()
    summary["status"] = "ok"
    summary["cache"] = "hit" if session._cache_hit else "miss"
    return summary


def _cmd_click(args) -> dict:
    session = GdsSession(args.gds, use_cache=not args.no_cache)
    session.parse()
    cache_status = "hit" if session._cache_hit else "miss"
    if args.at:
        parts = args.at.split(",")
        x, y = float(parts[0]), float(parts[1])
        idx, dist = session.click(x, y)
        if idx is None:
            return {"status": "error", "message": f"No feature found near ({x}, {y})"}
        result = _format_feature(idx, session.features[idx], dist)
        result["cache"] = cache_status
        return result
    elif args.index is not None:
        feat = session.click_index(args.index)
        if feat is None:
            return {"status": "error", "message": f"No feature at index {args.index}"}
        result = _format_feature(args.index, feat)
        result["cache"] = cache_status
        return result
    return {"status": "error", "message": "Specify --at x,y or --index N"}


def _cmd_ctrl_a(args) -> dict:
    session = GdsSession(args.gds, use_cache=not args.no_cache)
    session.parse()
    result = session.ctrl_a(args.index, args.level)
    if result is None:
        return {"status": "error", "message": f"No feature at index {args.index}"}
    # Build group_provenance list
    group_prov = []
    for i in result["group_indices"]:
        prov = session.features[i].get("properties", {}).get("provenance", {})
        entry = {"index": i}
        if prov.get("instance_name"):
            entry["instance_name"] = prov["instance_name"]
        if prov.get("array_index"):
            entry["array_index"] = prov["array_index"]
        if prov.get("loop_index"):
            entry["loop_index"] = prov["loop_index"]
        group_prov.append(entry)
    return {
        "status": "ok",
        "anchor_index": args.index,
        "level": args.level,
        "group_indices": result["group_indices"],
        "group_provenance": group_prov,
        "cache": "hit" if session._cache_hit else "miss",
    }


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
        handlers = {
            "parse": _cmd_parse,
            "click": _cmd_click,
            "ctrl-a": _cmd_ctrl_a,
            "diagnose": lambda a: {"status": "error", "message": "diagnose not implemented yet"},
        }
        result = handlers[args.command](args)
    except Exception as e:
        result = {"status": "error", "message": str(e)}

    print(json.dumps(result, indent=2 if args.verbose else None))


if __name__ == "__main__":
    main()
