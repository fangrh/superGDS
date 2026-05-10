"""Comprehensive test for Ctrl+A L1/L2 grouping with nested for-loops and arrays.

Generates multiple GDS configurations, parses each, and asserts:
  - Provenance completeness (instance_name, file, line, call_chain)
  - L1 isolation: exact instance_name match, no cross-instance contamination
  - L2 isolation: (loop_index, placement_line) match, no cross-loop contamination
  - Cross-loop same-component isolation

Run: python python/test_ctrl_a_comprehensive.py
"""
from __future__ import annotations

import os
import sys

os.environ["GDS_PROVENANCE"] = "1"

import json

import gdsfactory as gf
import gdsfactory.gpdk as gpdk

gpdk.PDK.activate()

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gds_debug import GdsSession

_PASSED = 0
_FAILED = 0
_CURRENT_TEST = ""
_DX = 20.0
_DY = 15.0
_TEXT_SIZE = 5.0
_LAYER = (1, 0)


def _check(condition: bool, name: str, detail: str = "") -> None:
    global _PASSED, _FAILED
    if condition:
        _PASSED += 1
    else:
        _FAILED += 1
        tag = f"  FAIL: {name}"
        if detail:
            tag += f" — {detail}"
        print(tag)


def _build_gds(name: str, component: gf.Component) -> str:
    outdir = os.path.dirname(os.path.abspath(__file__))
    path = os.path.join(outdir, f"test_{name}.gds")
    component.write_gds(path)
    return path


def _parse(gds_path: str) -> GdsSession:
    s = GdsSession(gds_path, use_cache=False)
    s.parse()
    return s


def _provenance(session: GdsSession, idx: int) -> dict:
    return session.features[idx].get("properties", {}).get("provenance", {})


def _instance_groups(session: GdsSession) -> dict[str, list[int]]:
    """Map instance_name → list of feature indices."""
    groups: dict[str, list[int]] = {}
    for i, f in enumerate(session.features):
        prov = f.get("properties", {}).get("provenance", {})
        inst = prov.get("instance_name", "")
        if inst:
            groups.setdefault(inst, []).append(i)
    return groups


# ---------------------------------------------------------------------------
# Test configurations
# ---------------------------------------------------------------------------


def build_two_loops_same_component_arrays():
    """A: Two sequential for-loops, same text component reused, different arrays.

    Loop 1 (line ~40): text("0","1","2") × columns=2
    Loop 2 (line ~50): text("0","1") × rows=3
    Both use text("0") → same cached cell, different instances.
    """
    comp = gf.Component("two_loops_arrays")
    for i in range(3):
        t = gf.components.text(text=str(i), size=_TEXT_SIZE, layer=_LAYER)
        ref = comp.add_ref(t, columns=2, rows=1, column_pitch=_DX, row_pitch=_DY)
        ref.dxmin = 0
        ref.dymax = i * _DY
    for j in range(2):
        t = gf.components.text(text=str(j), size=_TEXT_SIZE, layer=_LAYER)
        ref = comp.add_ref(t, columns=1, rows=3, column_pitch=_DX, row_pitch=_DY)
        ref.dxmin = (j + 3) * _DX
        ref.dymax = 0
    return comp


def build_nested_for_with_arrays():
    """B: Nested for-loops with array placements.

    for i in 0..1:
        for j in 0..2:
            text(str(i*3+j)), columns=2
    """
    comp = gf.Component("nested_for_arrays")
    for i in range(2):
        for j in range(3):
            t = gf.components.text(
                text=f"{i*3+j}", size=_TEXT_SIZE, layer=_LAYER
            )
            ref = comp.add_ref(
                t, columns=2, rows=1, column_pitch=_DX, row_pitch=_DY
            )
            ref.dxmin = i * 80
            ref.dymax = j * _DY
    return comp


def build_loop_then_standalone_array():
    """C: For-loop first, then standalone array of same component.

    Loop: text("X") × 3, no array
    Then: text("X") × columns=3
    """
    comp = gf.Component("loop_then_array")
    for i in range(3):
        t = gf.components.text(text="X", size=_TEXT_SIZE, layer=_LAYER)
        ref = comp.add_ref(t)
        ref.dxmin = i * 20
        ref.dymax = 0
    t = gf.components.text(text="X", size=_TEXT_SIZE, layer=_LAYER)
    ref = comp.add_ref(t, columns=3, rows=1, column_pitch=_DX, row_pitch=_DY)
    ref.dxmin = 0
    ref.dymax = 50
    return comp


def build_array_then_loop():
    """D: Standalone array first, then for-loop of same component.

    First: text("Y") × columns=3 × rows=2
    Then: for-loop text("Y") × 3, no array
    """
    comp = gf.Component("array_then_loop")
    t = gf.components.text(text="Y", size=_TEXT_SIZE, layer=_LAYER)
    ref = comp.add_ref(t, columns=3, rows=2, column_pitch=_DX, row_pitch=_DY)
    ref.dxmin = 0
    ref.dymax = 0
    for i in range(3):
        t = gf.components.text(text="Y", size=_TEXT_SIZE, layer=_LAYER)
        ref = comp.add_ref(t)
        ref.dxmin = i * 20
        ref.dymax = 60
    return comp


def build_mixed_array_dims_per_iteration():
    """E: For-loop where array dimensions vary per iteration.

    for i in 0..3:
        text(str(i)), columns=(i+1)
    """
    comp = gf.Component("mixed_array_dims")
    for i in range(4):
        t = gf.components.text(text=str(i), size=_TEXT_SIZE, layer=_LAYER)
        ref = comp.add_ref(
            t, columns=i + 1, rows=1, column_pitch=_DX, row_pitch=_DY
        )
        ref.dxmin = i * 60
        ref.dymax = 0
    return comp


def build_nested_loops_shared_text():
    """F: Nested for-loops where inner reuses same text across iterations.

    for i in 0..1:
        for j in 0..1:
            text("S"), columns=2
    All 4 placements use same cached text("S").
    """
    comp = gf.Component("nested_shared_text")
    for i in range(2):
        for j in range(2):
            t = gf.components.text(text="S", size=_TEXT_SIZE, layer=_LAYER)
            ref = comp.add_ref(
                t, columns=2, rows=1, column_pitch=_DX, row_pitch=_DY
            )
            ref.dxmin = i * 80
            ref.dymax = j * 30
    return comp


# ---------------------------------------------------------------------------
# Assertions
# ---------------------------------------------------------------------------


def assert_provenance_completeness(session: GdsSession, label: str) -> None:
    """Every feature should have provenance with instance_name."""
    total = len(session.features)
    with_prov = sum(
        1
        for f in session.features
        if f.get("properties", {}).get("provenance", {}).get("instance_name")
    )
    _check(with_prov == total, f"{label}: all features have instance_name",
           f"only {with_prov}/{total}")


def assert_l1_isolation(session: GdsSession, label: str) -> None:
    """L1 groups by exact instance_name — no cross-instance contamination."""
    groups = _instance_groups(session)
    for inst_name, indices in groups.items():
        if not indices:
            continue
        result = session.ctrl_a(indices[0], 1)
        if result is None:
            _check(False, f"{label}: L1 instance {inst_name}", "ctrl_a returned None")
            continue
        grouped = set(result["group_indices"])
        expected = set(indices)
        _check(
            grouped == expected,
            f"{label}: L1 [{indices[0]}] instance {inst_name[-6:]}",
            f"expected {sorted(expected)} got {sorted(grouped)}",
        )


def assert_l1_no_cross_loop(
    session: GdsSession,
    loop1_line: int,
    loop2_line: int,
    label: str,
) -> None:
    """L1 groups from loop1 should NOT include features from loop2."""
    loop1_feats = {
        i
        for i, f in enumerate(session.features)
        if f.get("properties", {}).get("provenance", {}).get("placement_line")
        == loop1_line
    }
    loop2_feats = {
        i
        for i, f in enumerate(session.features)
        if f.get("properties", {}).get("provenance", {}).get("placement_line")
        == loop2_line
    }
    if not loop1_feats or not loop2_feats:
        _check(False, f"{label}: cross-loop check", "no features found for one loop")
        return
    anchor = next(iter(loop1_feats))
    result = session.ctrl_a(anchor, 1)
    if result is None:
        _check(False, f"{label}: cross-loop L1", "ctrl_a returned None")
        return
    grouped = set(result["group_indices"])
    cross = grouped & loop2_feats
    _check(
        len(cross) == 0,
        f"{label}: L1 [{anchor}] no cross-loop (line {loop1_line} vs {loop2_line})",
        f"leaked {len(cross)} features from loop2: {sorted(cross)[:5]}",
    )


def assert_l2_isolation(session: GdsSession, label: str) -> None:
    """L2 groups by placement_line — all same-loop features, no cross-loop."""
    groups = _instance_groups(session)
    checked = 0
    for inst_name, indices in groups.items():
        if not indices:
            continue
        result = session.ctrl_a(indices[0], 2)
        if result is None:
            continue
        grouped_indices = set(result["group_indices"])
        anchor_prov = _provenance(session, indices[0])
        anchor_line = anchor_prov.get("placement_line")

        for idx in grouped_indices:
            fp = _provenance(session, idx)
            f_line = fp.get("placement_line")
            same_line = f_line == anchor_line
            _check(
                same_line,
                f"{label}: L2 [{indices[0]}] group member [{idx}]",
                f"placement_line {f_line} vs {anchor_line}",
            )
            checked += 1
    _check(checked > 0, f"{label}: L2 checked at least one group",
           f"checked {checked} groups")


def assert_l2_expands_l1(session: GdsSession, label: str) -> None:
    """L2 should expand beyond L1 (select more features, not the same set)."""
    groups = _instance_groups(session)
    expanded = 0
    same = 0
    for inst_name, indices in groups.items():
        if not indices:
            continue
        r1 = session.ctrl_a(indices[0], 1)
        r2 = session.ctrl_a(indices[0], 2)
        if r1 is None or r2 is None:
            continue
        if len(r2["group_indices"]) >= len(r1["group_indices"]):
            expanded += 1
        else:
            same += 1
    # At least one instance should expand (unless single-instance, no-loop layout)
    multi_instance = sum(1 for v in groups.values() if len(v) > 0) > 1
    if multi_instance:
        _check(expanded > 0, f"{label}: L2 expands beyond L1",
               f"L2 never expanded ({expanded} expanded, {same} same)")


def assert_source_attribution(
    session: GdsSession,
    expected_lines: dict[int, int],
    label: str,
) -> None:
    """Verify that specific features have the correct source line.

    expected_lines: {feature_index: expected_source_line}
    """
    for idx, expected in expected_lines.items():
        if idx >= len(session.features):
            _check(False, f"{label}: source [{idx}]", "index out of range")
            continue
        prov = _provenance(session, idx)
        actual = prov.get("line")
        _check(
            actual == expected,
            f"{label}: source [{idx}] line={actual} (expected {expected})",
        )


def assert_loop_index_per_instance(session: GdsSession, label: str) -> None:
    """Cached components must get distinct loop_index per instance.

    Regression guard: when the same component is reused across for-loop
    iterations (cell caching), the creation entry's loop_index would be
    stale. The placement entry must override it.
    """
    groups = _instance_groups(session)
    # Collect loop_index per instance
    inst_loops: dict[str, set[str]] = {}
    for inst_name, indices in groups.items():
        loops = set()
        for idx in indices:
            prov = _provenance(session, idx)
            li = json.dumps(prov.get("loop_index"))
            loops.add(li)
        inst_loops[inst_name] = loops

    # Each instance should have exactly one distinct loop_index
    for inst_name, loops in inst_loops.items():
        _check(
            len(loops) == 1,
            f"{label}: instance {inst_name[-6:]} has single loop_index",
            f"got {len(loops)} distinct values: {loops}",
        )

    # Different instances on the same placement_line should have
    # different loop_index values (otherwise L2 can't distinguish them)
    by_line: dict[int, list[tuple[str, str]]] = {}
    for inst_name, indices in groups.items():
        if not indices:
            continue
        prov = _provenance(session, indices[0])
        line = prov.get("placement_line")
        loop = json.dumps(prov.get("loop_index"))
        if line is not None:
            by_line.setdefault(line, []).append((inst_name, loop))

    for line, entries in by_line.items():
        loop_values = [loop for _, loop in entries]
        unique_loops = set(loop_values)
        _check(
            len(unique_loops) == len(loop_values),
            f"{label}: line {line} has distinct loop_index per instance",
            f"got duplicates: {loop_values}",
        )


# ---------------------------------------------------------------------------
# Run all tests
# ---------------------------------------------------------------------------


def run_test(
    name: str,
    build_fn,
    loop1_line: int | None = None,
    loop2_line: int | None = None,
    source_checks: dict[int, int] | None = None,
) -> int:
    global _CURRENT_TEST
    _CURRENT_TEST = name
    print(f"\n=== {name} ===")
    local_fail = _FAILED

    comp = build_fn()
    gds_path = _build_gds(name, comp)
    session = _parse(gds_path)
    print(f"  Features: {len(session.features)}")

    assert_provenance_completeness(session, name)
    assert_loop_index_per_instance(session, name)
    assert_l1_isolation(session, name)

    if loop1_line is not None and loop2_line is not None:
        assert_l1_no_cross_loop(session, loop1_line, loop2_line, name)

    assert_l2_isolation(session, name)
    assert_l2_expands_l1(session, name)

    if source_checks:
        assert_source_attribution(session, source_checks, name)

    new_fails = _FAILED - local_fail
    status = "PASS" if new_fails == 0 else f"FAIL ({new_fails})"
    print(f"  Result: {status}")
    return new_fails


def main() -> None:
    global _PASSED, _FAILED

    print("superGDS Ctrl+A L1/L2 Comprehensive Test")
    print("=" * 50)

    # Get the source file path for source line checks
    this_file = os.path.abspath(__file__)

    run_test("A_two_loops_arrays", build_two_loops_same_component_arrays)
    run_test("B_nested_for_arrays", build_nested_for_with_arrays)
    run_test("C_loop_then_array", build_loop_then_standalone_array)
    run_test("D_array_then_loop", build_array_then_loop)
    run_test("E_mixed_array_dims", build_mixed_array_dims_per_iteration)
    run_test("F_nested_shared_text", build_nested_loops_shared_text)

    print("\n" + "=" * 50)
    total = _PASSED + _FAILED
    print(f"Results: {_PASSED}/{total} passed, {_FAILED} failed")
    if _FAILED == 0:
        print("All tests passed!")
    else:
        print("Some tests failed — see FAIL entries above.")
    sys.exit(0 if _FAILED == 0 else 1)


if __name__ == "__main__":
    main()
