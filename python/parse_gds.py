"""Parse a .gds file into GeoJSON + provenance. Called from VS Code extension."""
import json
import sys
import os

_DBG = True  # set to True to log array-index diagnostics
_DBG_LOG: list = []


LAYER_COLORS = [
    "#4ecdc4", "#ff6b6b", "#45b7d1", "#96ceb4",
    "#ffeaa7", "#dfe6e9", "#fd79a8", "#a29bfe",
    "#6c5ce7", "#00b894", "#e17055", "#0984e3",
    "#fab1a0", "#81ecec", "#55efc4", "#74b9ff",
]

PROVENANCE_LAYER = (255, 255)
PLACEMENT_PROP_KEY = 1004
INSTANCE_PROP_KEY = 1005
PROV_ID_PROP_KEY = 1002


def _load_sidecar(gds_path):
    """Load provenance sidecar JSON for a GDS file.

    Returns a tuple of (entries_by_id, ports_by_component, ref_names).
    entries_by_id: dict mapping prov_id (int) to the corresponding entry dict.
    ports_by_component: dict mapping component name to list of port dicts.
    ref_names: dict mapping instance name to component name.
    """
    import re

    base = re.sub(r"\.gds$", "", gds_path, flags=re.IGNORECASE)
    sidecar_path = base + ".provenance.json"
    if not os.path.exists(sidecar_path):
        return {}, {}, {}
    try:
        with open(sidecar_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        entries = data.get("entries", [])
        entries_by_id = {entry["id"]: entry for entry in entries if "id" in entry}
        ports_by_component = data.get("ports", {})
        ref_names = data.get("ref_names", {})
        return entries_by_id, ports_by_component, ref_names
    except Exception:
        return {}, {}, {}


def _parse_call_stack_string(frame_str):
    """Parse a call-stack frame string into a structured dict.

    Accepts strings like ``"user_script.py:10 in make_top"`` and returns
    ``{"file": "user_script.py", "line": 10, "function": "make_top"}``.
    Returns ``None`` if the string does not match the expected pattern.
    """
    import re as _re

    m = _re.match(r"^(.+?):(\d+)\s+in\s+(.+)$", frame_str)
    if not m:
        return None
    return {"file": m.group(1), "line": int(m.group(2)), "function": m.group(3)}


def _build_provenance_from_sidecar(entry, cell_name, ports_by_component=None):
    """Build a provenance dict from a sidecar entry and cell name.

    Returns a dict with keys: file, line, function, call_chain, cell,
    and optionally source_text and ports.
    """
    primary_file = entry["file"]
    primary_dir = os.path.dirname(primary_file) if primary_file else ""

    call_chain = [{"file": primary_file, "line": entry["line"], "function": entry["function"]}]
    for frame_str in entry.get("call_stack", []):
        parsed = _parse_call_stack_string(frame_str)
        if parsed is not None:
            # call_stack uses bare filenames (pathlib.Path.name),
            # resolve them against the primary entry's directory
            if primary_dir and not os.path.isabs(parsed["file"]):
                parsed = {**parsed, "file": os.path.join(primary_dir, parsed["file"])}
            call_chain.append(parsed)

    prov = {
        "file": entry["file"],
        "line": entry["line"],
        "function": entry["function"],
        "call_chain": call_chain,
        "cell": cell_name or entry.get("component", ""),
    }
    source_text = entry.get("source_text")
    if source_text:
        prov["source_text"] = source_text
    loop_index = entry.get("loop_index")
    if loop_index:
        prov["loop_index"] = loop_index

    variable_name = entry.get("variable_name")
    if variable_name:
        prov["variable_name"] = variable_name
    variable_in_loop = entry.get("variable_in_loop")
    if variable_in_loop:
        prov["variable_in_loop"] = variable_in_loop

    # Attach ports for this component
    if ports_by_component:
        comp_name = entry.get("component", "")
        cell = cell_name or comp_name
        ports = ports_by_component.get(comp_name) or ports_by_component.get(cell)
        if ports:
            prov["ports"] = ports

    return prov


def _extract_provenance(layout):
    """Return ``{cell_name: provenance_dict}`` from TEXT on layer 255/255."""
    import klayout.db as kdb

    prov = {}
    prov_li = layout.layer(*PROVENANCE_LAYER)
    if prov_li is None:
        return prov
    for ci in range(layout.cells()):
        cell = layout.cell(ci)
        for shape in cell.shapes(prov_li).each(kdb.Shapes.STexts):
            try:
                entry = json.loads(shape.text.string)
                name = entry.get("cell") or cell.name or ""
                if name:
                    prov[name] = entry
            except Exception:
                pass
    return prov


def _polygon_metadata(ring):
    xs = [p[0] for p in ring]
    ys = [p[1] for p in ring]
    area = 0.5 * abs(sum(
        xs[i] * ys[i + 1] - xs[i + 1] * ys[i]
        for i in range(len(ring) - 1)
    ))
    return {
        "area_um2": round(area, 4),
        "vertex_count": len(ring) - 1,
        "bbox": [round(min(xs), 6), round(min(ys), 6), round(max(xs), 6), round(max(ys), 6)],
    }


def _parse_json_property(value):
    if value in (None, ""):
        return None
    if isinstance(value, str):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return None
    return None


def _shape_to_ring(shape, itrans, dbu):
    import klayout.db as kdb

    polygon = None
    if shape.is_polygon():
        polygon = shape.polygon
    elif shape.is_box():
        polygon = kdb.Polygon(shape.box)
    elif shape.is_path():
        polygon = shape.path.polygon()

    if polygon is None:
        return None

    pts = polygon.transformed(itrans).to_simple_polygon()
    ring = [[p.x * dbu, p.y * dbu] for p in pts.each_point()]
    if len(ring) < 3:
        return None
    ring.append(ring[0])
    return ring


def _get_instance_name(iterator):
    try:
        path = iterator.path()
    except Exception:
        return None
    if not path:
        return None
    try:
        return path[-1].inst().property(0)
    except Exception:
        return None


def _get_feature_provenance(iterator, provenance_by_cell, sidecar_by_id, ports_by_component=None, ref_names=None):
    prov = None
    instance_name = _get_instance_name(iterator)

    try:
        cell_name = iterator.cell().name
    except Exception:
        cell_name = None

    # --- Sidecar provenance (highest priority) ---
    if sidecar_by_id:
        try:
            prov_id_raw = iterator.shape().property(PROV_ID_PROP_KEY)
            if prov_id_raw is not None:
                prov_id = int(prov_id_raw)
                entry = sidecar_by_id.get(prov_id)
                if entry is not None:
                    prov = _build_provenance_from_sidecar(entry, cell_name, ports_by_component)
        except Exception:
            prov = None

    # --- Instance property (1005) ---
    if prov is None:
        try:
            path = iterator.path()
        except Exception:
            path = []
        if path:
            try:
                prov = _parse_json_property(path[-1].inst().property(INSTANCE_PROP_KEY))
            except Exception:
                prov = None

    # --- Shape property (1004) ---
    if prov is None:
        try:
            prov = _parse_json_property(iterator.shape().property(PLACEMENT_PROP_KEY))
        except Exception:
            prov = None

    # --- Cell-level provenance ---
    if prov is None and cell_name:
        prov = provenance_by_cell.get(cell_name)

    if prov is None:
        prov = {}
    else:
        prov = dict(prov)

    # Resolve placement entry from sidecar for loop_index and instance_name.
    # The shape's own sidecar entry (from capture()) may have loop_index
    # already, but the placement entry (from track_instance()) has
    # instance_path which contains the instance name.
    placement_entry = None
    if sidecar_by_id:
        instance_prov_id = None
        # Try instance property (1005) first — current approach
        try:
            path = iterator.path()
            if path:
                inst_tag = _parse_json_property(
                    path[-1].inst().property(INSTANCE_PROP_KEY)
                )
                if inst_tag and "instance_prov_id" in inst_tag:
                    instance_prov_id = inst_tag["instance_prov_id"]
        except Exception:
            pass
        # Fallback: shape property (1004) — legacy approach
        if instance_prov_id is None:
            try:
                placement_tag = _parse_json_property(
                    iterator.shape().property(PLACEMENT_PROP_KEY)
                )
                if placement_tag and "instance_prov_id" in placement_tag:
                    instance_prov_id = placement_tag["instance_prov_id"]
            except Exception:
                pass
        if instance_prov_id is not None:
            placement_entry = sidecar_by_id.get(instance_prov_id)

    # Merge loop_index from placement entry (if not already present)
    if "loop_index" not in prov and placement_entry:
        if "loop_index" in placement_entry:
            prov["loop_index"] = placement_entry["loop_index"]

    # Merge variable_name from placement entry (if not already present)
    if "variable_name" not in prov and placement_entry:
        if "variable_name" in placement_entry:
            prov["variable_name"] = placement_entry["variable_name"]
            if "variable_in_loop" in placement_entry:
                prov["variable_in_loop"] = placement_entry["variable_in_loop"]

    # Extract instance name from placement entry's instance_path
    if not instance_name and placement_entry:
        inst_path = placement_entry.get("instance_path", "")
        if inst_path and "/" in inst_path:
            instance_name = inst_path.rsplit("/", 1)[-1]

    if instance_name:
        prov["instance_name"] = instance_name
    elif ref_names and cell_name:
        # Fallback: resolve instance name from sidecar ref_names
        if ref_names.get(cell_name):
            prov["instance_name"] = cell_name
    if cell_name and "cell" not in prov:
        prov["cell"] = cell_name

    return prov or None


def _compute_array_element_index(iterator):
    """Compute per-element [col, row] index for shapes inside array instances.

    The KLayout RecursiveShapeIterator's path may contain multiple instances.
    We walk the path to find the *innermost* array instance and compute the
    per-element index from the displacement delta between the base cell
    instance and the element-specific cell instance.  Inner arrays take
    priority because they represent the closest repeat structure to the shape.

    Uses InstElement-level transformations (cell_inst.trans) rather than
    iterator.itrans() to avoid shape-local coordinate offsets that would
    contaminate the array-element displacement computation.
    """
    import klayout.db as _kdb

    try:
        path = iterator.path()
        if not path:
            return None

        # Walk path from innermost outward to find the first array instance.
        array_path_idx = None
        for idx in range(len(path) - 1, -1, -1):
            inst = path[idx].inst()
            if inst.na > 1 or inst.nb > 1:
                array_path_idx = idx
                break
        if array_path_idx is None:
            return None

        inst = path[array_path_idx].inst()
        na, nb = inst.na, inst.nb
        a, b = inst.a, inst.b

        # Compose parent transforms (everything above the array instance).
        parent = _kdb.Trans()
        for i in range(array_path_idx):
            parent = parent * path[i].inst().cell_inst.trans

        # InstElement.ia() / ib() give the exact per-element indices directly
        # for both 2D (na>1, nb>1) and 1D (na=1 or nb=1) arrays — no coordinate
        # arithmetic needed, and avoids Cramer's-rule edge cases.
        elem = path[array_path_idx]
        col = max(0, min(int(elem.ia()), na - 1)) if na > 1 else 0
        row = max(0, min(int(elem.ib()), nb - 1)) if nb > 1 else 0

        result = [max(0, min(int(col), na - 1)), max(0, min(int(row), nb - 1))]

        if _DBG and _DBG_LOG:
            _DBG_LOG[-1]["col"] = col
            _DBG_LOG[-1]["row"] = row
            _DBG_LOG[-1]["result"] = result

        return result
    except Exception as e:
        if _DBG:
            import traceback as _tb
            _DBG_LOG.append({"error": str(e), "traceback": _tb.format_exc()})
        return None


def parse_gds(filepath: str) -> dict:
    """Parse a .gds file and return GeoJSON FeatureCollection."""
    import klayout.db as kdb

    layout = kdb.Layout()
    layout.read(filepath)

    provenance_by_cell = _extract_provenance(layout)
    sidecar_by_id, ports_by_component, ref_names = _load_sidecar(filepath)

    top = layout.top_cell()
    if top is None:
        return {"type": "FeatureCollection", "features": []}
    features = []
    min_x = min_y = float("inf")
    max_x = max_y = float("-inf")
    for li in layout.layer_indexes():
        info = layout.layer_infos()[li]
        if (info.layer, info.datatype) == PROVENANCE_LAYER:
            continue
        it = top.begin_shapes_rec(li)
        if it.at_end():
            continue
        color = LAYER_COLORS[info.layer % len(LAYER_COLORS)]
        while not it.at_end():
            ring = _shape_to_ring(it.shape(), it.itrans(), layout.dbu)
            if ring is not None:
                properties = {
                    "layer": info.layer,
                    "data_type": info.datatype,
                    "color": color,
                    **_polygon_metadata(ring),
                }
                provenance = _get_feature_provenance(it, provenance_by_cell, sidecar_by_id, ports_by_component, ref_names)
                if provenance:
                    array_idx = _compute_array_element_index(it)
                    if array_idx is not None:
                        provenance["array_index"] = array_idx
                    properties["provenance"] = provenance
                features.append({
                    "type": "Feature",
                    "geometry": {"type": "Polygon", "coordinates": [ring]},
                    "properties": properties,
                })
                for x, y in ring:
                    min_x = min(min_x, x)
                    max_x = max(max_x, x)
                    min_y = min(min_y, y)
                    max_y = max(max_y, y)
            it.next()

    # Flush array-index diagnostics to a JSON log file next to the GDS.
    if _DBG and _DBG_LOG:
        import re as _re
        log_path = _re.sub(r"\.gds$", ".array_debug.json", filepath, flags=_re.IGNORECASE)
        try:
            with open(log_path, "w", encoding="utf-8") as _f:
                _json.dump(_DBG_LOG, _f, indent=2)
        except Exception:
            pass

    result = {"type": "FeatureCollection", "features": features}
    if features:
        result["bbox"] = [min_x, min_y, max_x, max_y]
    # Inject version marker + diagnostic summary so the viewer / TypeScript
    # layer can confirm which code ran and whether array-index was ever called.
    result["_diag"] = {
        "ver": 4,
        "dbg_on": _DBG,
        "array_calls": len(_DBG_LOG),
    }
    _DBG_LOG.clear()
    return result


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: parse_gds.py <file.gds>"}))
        sys.exit(1)

    gds_path = sys.argv[1]
    if not os.path.exists(gds_path):
        print(json.dumps({"error": f"File not found: {gds_path}"}))
        sys.exit(1)

    try:
        result = parse_gds(gds_path)
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
