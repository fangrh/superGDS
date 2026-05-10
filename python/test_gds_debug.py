"""Tests for gds_debug.py CLI debug mode."""
import json
import os
import pickle
import tempfile
import time
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
            # Overwrite GDS -> new mtime (sleep to ensure mtime changes)
            time.sleep(0.01)
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
