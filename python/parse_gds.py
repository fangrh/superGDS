"""Parse a .gds file into GeoJSON + provenance. Called from VS Code extension."""
import json
import sys
import os


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

    Looks for ``<gds_path_without_suffix>.provenance.json`` and returns
    a dict mapping prov_id (int) to the corresponding entry dict.
    Returns an empty dict if the sidecar file does not exist or cannot
    be parsed.
    """
    import re

    base = re.sub(r"\.gds$", "", gds_path, flags=re.IGNORECASE)
    sidecar_path = base + ".provenance.json"
    if not os.path.exists(sidecar_path):
        return {}
    try:
        with open(sidecar_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        entries = data.get("entries", [])
        return {entry["id"]: entry for entry in entries if "id" in entry}
    except Exception:
        return {}


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


def _build_provenance_from_sidecar(entry, cell_name):
    """Build a provenance dict from a sidecar entry and cell name.

    Returns a dict with keys: file, line, function, call_chain, cell,
    and optionally source_text.
    """
    call_chain = [{"file": entry["file"], "line": entry["line"], "function": entry["function"]}]
    for frame_str in entry.get("call_stack", []):
        parsed = _parse_call_stack_string(frame_str)
        if parsed is not None:
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


def _get_feature_provenance(iterator, provenance_by_cell, sidecar_by_id):
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
                    prov = _build_provenance_from_sidecar(entry, cell_name)
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

    if instance_name:
        prov["instance_name"] = instance_name
    if cell_name and "cell" not in prov:
        prov["cell"] = cell_name

    return prov or None


def parse_gds(filepath: str) -> dict:
    """Parse a .gds file and return GeoJSON FeatureCollection."""
    import klayout.db as kdb

    layout = kdb.Layout()
    layout.read(filepath)

    provenance_by_cell = _extract_provenance(layout)
    sidecar_by_id = _load_sidecar(filepath)

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
                provenance = _get_feature_provenance(it, provenance_by_cell, sidecar_by_id)
                if provenance:
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

    result = {"type": "FeatureCollection", "features": features}
    if features:
        result["bbox"] = [min_x, min_y, max_x, max_y]
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
