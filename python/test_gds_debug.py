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


if __name__ == "__main__":
    unittest.main()
