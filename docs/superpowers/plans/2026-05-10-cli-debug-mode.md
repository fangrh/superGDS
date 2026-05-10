# CLI Debug Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a headless Python CLI that lets AI agents test and debug GDS provenance logic (parse, click, Ctrl+A grouping, diagnostics) without VS Code or a browser.

**Architecture:** Single `python/gds_debug.py` script with `GdsCache` (pickle + mtime), `GdsSession` (query operations on parsed GeoJSON), and argparse subcommands outputting JSON. Reuses `parse_gds.parse_gds()` for parsing; ports JS grouping logic from `viewer.html` to Python.

**Tech Stack:** Python 3, argparse, pickle, json, re. No new dependencies.

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `python/gds_debug.py` | Create | CLI entry point, GdsCache, GdsSession, all subcommands |
| `python/test_gds_debug.py` | Create | Unit tests with synthetic feature data |

---

### Task 1: GdsCache + GdsSession skeleton + parse subcommand

**Files:**
- Create: `python/gds_debug.py`
- Create: `python/test_gds_debug.py`

- [ ] **Step 1: Write tests for GdsCache and parse summary**

Create `python/test_gds_debug.py`:

```python
"""Tests for gds_debug.py CLI debug mode."""
import json
import os
import pickle
import tempfile
import unittest

import gds_debug as D


def _make_feature(layer="1/0", x=0.0, y=0.0, w=10.0, h=10.0, provenance=None):
    """Create a synthetic GeoJSON feature for testing."""
    return {
        "type": "Feature",
        "geometry": {
            "type": "Polygon",
            "coordinates": [[[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]]],
        },
        "properties": {
            "layer": layer,
            "data_type": 0,
            "color": "#fff",
            "area_um2": w * h,
            "vertex_count": 4,
            "bbox": [x, y, x + w, y + h],
            "provenance": provenance or {},
        },
    }


class TestGdsCache(unittest.TestCase):
    def test_returns_none_when_no_cache_file(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            gds_path = os.path.join(tmpdir, "test.gds")
            with open(gds_path, "w") as f:
                f.write("dummy")
            cache = D.GdsCache(gds_path)
            self.assertIsNone(cache.load())

    def test_round_trip(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            gds_path = os.path.join(tmpdir, "test.gds")
            with open(gds_path, "w") as f:
                f.write("dummy")
            cache = D.GdsCache(gds_path)
            data = {"features": [_make_feature()], "bbox": [0, 0, 10, 10]}
            cache.save(data)
            loaded = cache.load()
            self.assertEqual(loaded["features"][0]["properties"]["layer"], "1/0")

    def test_invalidates_on_mtime_change(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            gds_path = os.path.join(tmpdir, "test.gds")
            with open(gds_path, "w") as f:
                f.write("v1")
            cache = D.GdsCache(gds_path)
            cache.save({"features": [], "bbox": None})
            # Overwrite GDS → new mtime
            with open(gds_path, "w") as f:
                f.write("v2")
            self.assertIsNone(cache.load())

    def test_corrupt_pickle_returns_none(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            gds_path = os.path.join(tmpdir, "test.gds")
            with open(gds_path, "w") as f:
                f.write("dummy")
            cache = D.GdsCache(gds_path)
            # Write garbage to cache file
            with open(cache._path, "wb") as f:
                f.write(b"not a pickle")
            self.assertIsNone(cache.load())


class TestParseSummary(unittest.TestCase):
    def test_summary_from_features(self):
        features = [
            _make_feature(layer="1/0"),
            _make_feature(layer="2/0", x=20),
            _make_feature(layer="1/0", x=40),
        ]
        session = D.GdsSession.__new__(D.GdsSession)
        session.features = features
        session.bbox = [0, 0, 50, 10]
        session._cache_hit = False
        summary = session.parse_summary()
        self.assertEqual(summary["features"], 3)
        self.assertEqual(summary["layers"], ["1/0", "2/0"])
        self.assertEqual(summary["bbox"], [0, 0, 50, 10])


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd python && python -m pytest test_gds_debug.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'gds_debug'`

- [ ] **Step 3: Implement GdsCache + GdsSession skeleton + parse subcommand**

Create `python/gds_debug.py`:

```python
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd python && python -m pytest test_gds_debug.py -v`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add python/gds_debug.py python/test_gds_debug.py
git commit -m "feat(debug): add CLI debug mode with GdsCache and parse subcommand"
```

---

### Task 2: Click subcommand (--at and --index)

**Files:**
- Modify: `python/gds_debug.py`
- Modify: `python/test_gds_debug.py`

- [ ] **Step 1: Write tests for click and click_index**

Append to `python/test_gds_debug.py` after the existing `TestParseSummary` class:

```python
class TestClick(unittest.TestCase):
    def setUp(self):
        self.features = [
            _make_feature(x=0, y=0, w=10, h=10, provenance={"instance_name": "a_0", "cell": "rect"}),
            _make_feature(x=20, y=0, w=10, h=10, provenance={"instance_name": "a_1", "cell": "rect"}),
            _make_feature(x=0, y=20, w=10, h=10, provenance={"instance_name": "b_0", "cell": "circle"}),
        ]
        self.session = D.GdsSession.__new__(D.GdsSession)
        self.session.features = self.features
        self.session.bbox = [0, 0, 30, 30]
        self.session._cache_hit = False

    def test_click_nearest_centroid(self):
        idx, dist = self.session.click(5, 5)
        self.assertEqual(idx, 0)

    def test_click_second_feature(self):
        idx, dist = self.session.click(25, 5)
        self.assertEqual(idx, 1)

    def test_click_third_feature(self):
        idx, dist = self.session.click(5, 25)
        self.assertEqual(idx, 2)

    def test_click_returns_distance(self):
        idx, dist = self.session.click(25, 5)
        self.assertAlmostEqual(dist, 0.0, places=1)

    def test_click_index_valid(self):
        feat = self.session.click_index(1)
        self.assertEqual(feat["properties"]["provenance"]["instance_name"], "a_1")

    def test_click_index_out_of_range(self):
        self.assertIsNone(self.session.click_index(99))

    def test_click_no_features(self):
        empty = D.GdsSession.__new__(D.GdsSession)
        empty.features = []
        idx, dist = empty.click(0, 0)
        self.assertIsNone(idx)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd python && python -m pytest test_gds_debug.py::TestClick -v`
Expected: FAIL — `AttributeError: 'GdsSession' has no attribute 'click'`

- [ ] **Step 3: Implement click and click_index**

Add two methods to `GdsSession` in `python/gds_debug.py`, after `parse_summary`:

```python
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
```

Add the click subcommand handler and argparse registration. Add `_format_feature` helper and `_cmd_click` function before `main()`, and add the click subparser inside `main()`:

```python
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
```

Inside `main()`, add the click subparser after the parse subparser:

```python
    p_click = sub.add_parser("click", help="Select feature by coordinates or index")
    p_click.add_argument("gds", help="Path to .gds file")
    p_click.add_argument("--at", help="Click at x,y coordinates")
    p_click.add_argument("--index", type=int, help="Select feature by index")
```

Update the handlers dict to include click:

```python
        handlers = {"parse": _cmd_parse, "click": _cmd_click}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd python && python -m pytest test_gds_debug.py -v`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add python/gds_debug.py python/test_gds_debug.py
git commit -m "feat(debug): add click subcommand with --at and --index"
```

---

### Task 3: Ctrl-A L1/L2 grouping subcommand

**Files:**
- Modify: `python/gds_debug.py`
- Modify: `python/test_gds_debug.py`

- [ ] **Step 1: Write tests for ctrl_a L1 and L2**

Append to `python/test_gds_debug.py`:

```python
class TestCtrlA(unittest.TestCase):
    def setUp(self):
        # ring_0 through ring_5: 6 features with same instance_name base
        # loop_index [0],[1],[2] from "loop A", then [0],[1],[2] from "loop B"
        self.features = [
            _make_feature(x=0, provenance={"instance_name": "ring_0", "cell": "ring", "loop_index": [0], "array_index": [0, 0]}),
            _make_feature(x=20, provenance={"instance_name": "ring_1", "cell": "ring", "loop_index": [1], "array_index": [1, 0]}),
            _make_feature(x=40, provenance={"instance_name": "ring_2", "cell": "ring", "loop_index": [2], "array_index": [2, 0]}),
            _make_feature(x=60, provenance={"instance_name": "ring_3", "cell": "ring", "loop_index": [0], "array_index": [0, 0]}),
            _make_feature(x=80, provenance={"instance_name": "ring_4", "cell": "ring", "loop_index": [1], "array_index": [1, 0]}),
            _make_feature(x=100, provenance={"instance_name": "ring_5", "cell": "ring", "loop_index": [2], "array_index": [2, 0]}),
            _make_feature(x=200, provenance={"instance_name": "waveguide_0", "cell": "wg"}),
        ]
        self.session = D.GdsSession.__new__(D.GdsSession)
        self.session.features = self.features
        self.session.bbox = [0, 0, 210, 10]
        self.session._cache_hit = False

    def test_l1_groups_by_instance_name_base(self):
        result = self.session.ctrl_a(0, level=1)
        self.assertEqual(result["anchor_instance_base"], "ring")
        self.assertEqual(result["group_indices"], [0, 1, 2, 3, 4, 5])

    def test_l1_excludes_different_base(self):
        result = self.session.ctrl_a(6, level=1)
        self.assertEqual(result["anchor_instance_base"], "waveguide")
        self.assertEqual(result["group_indices"], [6])

    def test_l2_groups_by_loop_index(self):
        result = self.session.ctrl_a(0, level=2)
        # loop_index [0] matches features 0 and 3
        self.assertIn(0, result["group_indices"])
        self.assertIn(3, result["group_indices"])
        self.assertNotIn(1, result["group_indices"])

    def test_l2_no_loop_index_groups_all_without(self):
        features = [
            _make_feature(x=0, provenance={"instance_name": "a_0"}),
            _make_feature(x=20, provenance={"instance_name": "a_1"}),
        ]
        session = D.GdsSession.__new__(D.GdsSession)
        session.features = features
        result = session.ctrl_a(0, level=2)
        self.assertEqual(result["group_indices"], [0, 1])

    def test_ctrl_a_invalid_index(self):
        result = self.session.ctrl_a(99, level=1)
        self.assertIsNone(result)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd python && python -m pytest test_gds_debug.py::TestCtrlA -v`
Expected: FAIL — `AttributeError: 'GdsSession' has no attribute 'ctrl_a'`

- [ ] **Step 3: Implement ctrl_a**

Add `ctrl_a` method to `GdsSession` in `python/gds_debug.py`, after `click_index`:

```python
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
```

Add `_cmd_ctrl_a` handler function before `main()`:

```python
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
```

Add ctrl-a subparser inside `main()`, after the click subparser:

```python
    p_ctrl = sub.add_parser("ctrl-a", help="Simulate Ctrl+A grouping")
    p_ctrl.add_argument("gds", help="Path to .gds file")
    p_ctrl.add_argument("-i", "--index", type=int, required=True, help="Anchor feature index")
    p_ctrl.add_argument("-l", "--level", type=int, required=True, choices=[1, 2], help="Grouping level (1=L1, 2=L2)")
```

Update the handlers dict:

```python
        handlers = {"parse": _cmd_parse, "click": _cmd_click, "ctrl-a": _cmd_ctrl_a}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd python && python -m pytest test_gds_debug.py -v`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add python/gds_debug.py python/test_gds_debug.py
git commit -m "feat(debug): add ctrl-a subcommand with L1/L2 grouping"
```

---

### Task 4: Diagnose subcommand

**Files:**
- Modify: `python/gds_debug.py`
- Modify: `python/test_gds_debug.py`

- [ ] **Step 1: Write tests for diagnose**

Append to `python/test_gds_debug.py`:

```python
class TestDiagnose(unittest.TestCase):
    def test_basic_counts(self):
        features = [
            _make_feature(provenance={"file": "a.py", "line": 1, "cell": "rect", "instance_name": "r_0", "loop_index": [0]}),
            _make_feature(provenance={"file": "a.py", "line": 1, "cell": "rect", "instance_name": "r_1", "loop_index": [1]}),
            _make_feature(provenance={}),
        ]
        session = D.GdsSession.__new__(D.GdsSession)
        session.features = features
        session._cache_hit = False
        result = session.diagnose()
        self.assertEqual(result["total_features"], 3)
        self.assertEqual(result["with_provenance"], 2)
        self.assertEqual(result["with_loop_index"], 2)
        self.assertEqual(result["with_array_index"], 0)

    def test_ambiguous_loop_index_warning(self):
        features = [
            _make_feature(provenance={"file": "top.py", "line": 10, "loop_index": [0], "instance_name": "a_0"}),
            _make_feature(provenance={"file": "top.py", "line": 10, "loop_index": [1], "instance_name": "a_1"}),
            _make_feature(provenance={"file": "top.py", "line": 20, "loop_index": [0], "instance_name": "b_0"}),
        ]
        session = D.GdsSession.__new__(D.GdsSession)
        session.features = features
        session._cache_hit = False
        result = session.diagnose()
        ambig = [w for w in result["warnings"] if w["type"] == "ambiguous_loop_index"]
        self.assertEqual(len(ambig), 1)
        self.assertEqual(ambig[0]["distinct_sources"], 2)

    def test_shared_cell_overwrite_warning(self):
        features = [
            _make_feature(provenance={"cell": "rect", "instance_name": "r_0", "file": "a.py", "line": 1}),
            _make_feature(provenance={"cell": "rect", "instance_name": "r_1", "file": "a.py", "line": 1}),
            _make_feature(provenance={"cell": "rect", "instance_name": "r_2", "file": "a.py", "line": 1}),
        ]
        session = D.GdsSession.__new__(D.GdsSession)
        session.features = features
        session._cache_hit = False
        result = session.diagnose()
        shared = [w for w in result["warnings"] if w["type"] == "shared_cell_overwrite"]
        self.assertEqual(len(shared), 1)
        self.assertEqual(shared[0]["placements"], 3)

    def test_no_warnings_clean_data(self):
        features = [
            _make_feature(provenance={"file": "a.py", "line": 1, "cell": "rect", "instance_name": "r_0"}),
        ]
        session = D.GdsSession.__new__(D.GdsSession)
        session.features = features
        session._cache_hit = False
        result = session.diagnose()
        self.assertEqual(result["warnings"], [])

    def test_loop_index_distribution(self):
        features = [
            _make_feature(provenance={"loop_index": [0]}),
            _make_feature(provenance={"loop_index": [1]}),
            _make_feature(provenance={"loop_index": [2]}),
            _make_feature(provenance={"loop_index": [0]}),
        ]
        session = D.GdsSession.__new__(D.GdsSession)
        session.features = features
        session._cache_hit = False
        result = session.diagnose()
        self.assertEqual(result["loop_index_distribution"]["[0]"], 2)
        self.assertEqual(result["loop_index_distribution"]["[1]"], 1)
        self.assertEqual(result["loop_index_distribution"]["[2]"], 1)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd python && python -m pytest test_gds_debug.py::TestDiagnose -v`
Expected: FAIL — `AttributeError: 'GdsSession' has no attribute 'diagnose'`

- [ ] **Step 3: Implement diagnose**

Add `diagnose` method to `GdsSession` in `python/gds_debug.py`, after `ctrl_a`:

```python
    def diagnose(self) -> dict:
        """Run provenance diagnostics on parsed features."""
        total = len(self.features)
        with_prov = 0
        with_loop = 0
        with_array = 0
        loop_dist: dict[str, int] = {}
        warnings: list[dict] = []

        # cell -> set of instance_name values
        cell_instances: dict[str, set[str]] = {}
        # loop_index_key -> set of "file:line" sources
        loop_sources: dict[str, set[str]] = {}

        for feat in self.features:
            prov = feat.get("properties", {}).get("provenance", {})
            if not prov:
                continue
            with_prov += 1

            if prov.get("loop_index"):
                with_loop += 1
                key = json.dumps(prov["loop_index"])
                loop_dist[key] = loop_dist.get(key, 0) + 1
                src = f"{prov.get('file', '?')}:{prov.get('line', '?')}"
                if key not in loop_sources:
                    loop_sources[key] = set()
                loop_sources[key].add(src)

            if prov.get("array_index"):
                with_array += 1

            cell = prov.get("cell", "")
            inst = prov.get("instance_name", "")
            if cell and inst:
                if cell not in cell_instances:
                    cell_instances[cell] = set()
                cell_instances[cell].add(inst)

        # shared_cell_overwrite: same cell placed under multiple instance names
        for cell, instances in cell_instances.items():
            if len(instances) > 1:
                warnings.append({
                    "type": "shared_cell_overwrite",
                    "cell": cell,
                    "placements": len(instances),
                })

        # ambiguous_loop_index: same loop_index from different source locations
        for key, sources in loop_sources.items():
            if len(sources) > 1:
                warnings.append({
                    "type": "ambiguous_loop_index",
                    "loop_index": json.loads(key),
                    "distinct_sources": len(sources),
                    "files": sorted(sources),
                })

        return {
            "total_features": total,
            "with_provenance": with_prov,
            "with_loop_index": with_loop,
            "with_array_index": with_array,
            "loop_index_distribution": loop_dist,
            "warnings": warnings,
        }
```

Add `_cmd_diagnose` handler before `main()`:

```python
def _cmd_diagnose(args) -> dict:
    session = GdsSession(args.gds, use_cache=not args.no_cache)
    session.parse()
    result = session.diagnose()
    result["status"] = "ok"
    result["cache"] = "hit" if session._cache_hit else "miss"
    return result
```

Add diagnose subparser inside `main()`, after ctrl-a:

```python
    p_diag = sub.add_parser("diagnose", help="Provenance health check")
    p_diag.add_argument("gds", help="Path to .gds file")
```

Update the handlers dict:

```python
        handlers = {"parse": _cmd_parse, "click": _cmd_click, "ctrl-a": _cmd_ctrl_a, "diagnose": _cmd_diagnose}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd python && python -m pytest test_gds_debug.py -v`
Expected: All tests PASS

- [ ] **Step 5: Run all tests**

Run: `cd python && python -m pytest test_gds_debug.py -v`
Expected: All tests PASS (4 test classes, ~15 test methods)

- [ ] **Step 6: Commit**

```bash
git add python/gds_debug.py python/test_gds_debug.py
git commit -m "feat(debug): add diagnose subcommand with provenance health checks"
```
