import importlib.util
import inspect
import pathlib
import unittest


def load_provenance_module():
    module_path = (
        pathlib.Path(__file__).resolve().parents[1]
        / "gdsfactory"
        / "gdsfactory"
        / "provenance.py"
    )
    spec = importlib.util.spec_from_file_location("gf_provenance_under_test", module_path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class ProvenanceTrackerTests(unittest.TestCase):
    def test_track_instance_preserves_user_loop_index(self):
        provenance = load_provenance_module()
        provenance._reset_global_id()
        provenance._find_user_frame = lambda: {
            "file": "design.py",
            "line": 12,
            "function": "build",
            "source_text": "for idx, cell in enumerate(cells):",
            "call_stack": [],
            "loop_index": [4],
        }

        tracker = provenance.ProvenanceTracker()
        tracker.track_instance("top", "cell", "top/cell_1", "r0 *1 0,0")

        [entry] = tracker.get_sidecar()["entries"]
        self.assertEqual(entry["loop_index"], [4])

    def test_track_instance_prefers_array_dimensions_for_array_refs(self):
        provenance = load_provenance_module()
        provenance._reset_global_id()
        provenance._find_user_frame = lambda: {
            "file": "design.py",
            "line": 12,
            "function": "build",
            "source_text": "for idx, cell in enumerate(cells):",
            "call_stack": [],
            "loop_index": [4],
        }

        tracker = provenance.ProvenanceTracker()
        tracker.track_instance(
            "top",
            "cell",
            "top/cell_1",
            "r0 *1 0,0",
            columns=3,
            rows=2,
        )

        [entry] = tracker.get_sidecar()["entries"]
        self.assertEqual(entry["loop_index"], [3, 2])

    def test_explicit_provenance_loop_index_overrides_helper_loop_locals(self):
        provenance = load_provenance_module()

        def helper():
            _gds_provenance_loop_index = 7
            for seg_idx in range(2):
                if seg_idx == 0:
                    frame = inspect.currentframe()
                    self.assertIsNotNone(frame)
                    return provenance._try_extract_loop_index(
                        frame,
                        "comp << path.extrude(xs)",
                    )
            return None

        self.assertEqual(helper(), [7])


if __name__ == "__main__":
    unittest.main()
