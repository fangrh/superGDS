"""Build a test GDS matching real-world pattern: two for-loops, each creating
unique components and placing them as arrays.

Loop A (ROW_NUM=3): each iteration creates a text component, places as COL_NUM×1 array
Loop B (COL_NUM=2): each iteration creates a text component, places as 1×ROW_NUM array

Run: python build_test_gds.py
"""
import os
os.environ["GDS_PROVENANCE"] = "1"

import gdsfactory as gf
import gdsfactory.gpdk as gpdk

gpdk.PDK.activate()

ROW_NUM = 3
COL_NUM = 2
TEXT_SIZE = 5.0
dx = 20.0
dy = 15.0
label_base_x = 0.0
label_base_y = 0.0
X_NUM_SHIFT = (0, 0)
Y_NUM_SHIFT = (0, 0)


def build_test():
    comp = gf.Component("test_row_col_loops")

    # Loop A: row x-numbers — each iteration creates unique text, places as COL_NUM×1 array
    for i in range(ROW_NUM):
        idx_j = i - ROW_NUM // 2 + 1
        x_num = gf.components.text(
            text=str(idx_j), size=TEXT_SIZE, justify="right",
            layer=(1, 2),
        )
        x_ref = comp.add_ref(
            x_num, columns=COL_NUM, rows=1,
            column_pitch=dx, row_pitch=dy,
        )
        x_ref.dxmin = label_base_x + X_NUM_SHIFT[0]
        x_ref.dymax = label_base_y + i * dy + X_NUM_SHIFT[1]

    # Loop B: column y-numbers — each iteration creates unique text, places as 1×ROW_NUM array
    for j in range(COL_NUM):
        idx_i = j - COL_NUM // 2 + 1
        y_num = gf.components.text(
            text=str(idx_i), size=TEXT_SIZE, justify="right",
            layer=(1, 2),
        )
        y_ref = comp.add_ref(
            y_num, columns=1, rows=ROW_NUM,
            column_pitch=dx, row_pitch=dy,
        )
        y_ref.dxmin = label_base_x + j * dx + Y_NUM_SHIFT[0]
        y_ref.dymax = label_base_y + Y_NUM_SHIFT[1]

    return comp


if __name__ == "__main__":
    top = build_test()
    outdir = os.path.dirname(os.path.abspath(__file__))
    gds_path = os.path.join(outdir, "test_row_col_loops.gds")
    top.write_gds(gds_path)
    print(f"Written: {gds_path}")
