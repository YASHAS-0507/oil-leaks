"""Generate the 3D ship models (binary glTF) used by the Ship Tracker.

Writes web/models/{tanker,container,bulk}_{running,stalled,leaking}.glb.
The hull colour encodes the ship status. Ships face +Z with +Y up (glTF convention).
No dependencies beyond the Python standard library.
"""
import json
import struct
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "web" / "models"
SCALE = 70.0  # model units to metres: a ship is about 315 m long
STATUS = {"running": (0.24, 0.86, 0.52), "stalled": (0.96, 0.77, 0.26), "leaking": (1.0, 0.30, 0.30)}
PALETTE = [(0.76, 0.34, 0.23), (0.23, 0.43, 0.65), (0.85, 0.64, 0.23), (0.36, 0.54, 0.36), (0.55, 0.31, 0.62), (0.81, 0.81, 0.81)]


class Mesh:
    def __init__(self):
        self.pos, self.nor, self.col, self.idx = [], [], [], []

    def quad(self, a, b, c, d, color):
        """Add a flat quad (a,b,c,d counter-clockwise seen from outside)."""
        ux, uy, uz = (b[i] - a[i] for i in range(3))
        vx, vy, vz = (d[i] - a[i] for i in range(3))
        n = (uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx)
        ln = (n[0] ** 2 + n[1] ** 2 + n[2] ** 2) ** 0.5 or 1
        n = tuple(x / ln for x in n)
        base = len(self.pos)
        for p in (a, b, c, d):
            self.pos.append(tuple(x * SCALE for x in p)); self.nor.append(n); self.col.append(color)
        self.idx += [base, base + 1, base + 2, base, base + 2, base + 3]

    def tri(self, a, b, c, color):
        ux, uy, uz = (b[i] - a[i] for i in range(3))
        vx, vy, vz = (c[i] - a[i] for i in range(3))
        n = (uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx)
        ln = (n[0] ** 2 + n[1] ** 2 + n[2] ** 2) ** 0.5 or 1
        n = tuple(x / ln for x in n)
        base = len(self.pos)
        for p in (a, b, c):
            self.pos.append(tuple(x * SCALE for x in p)); self.nor.append(n); self.col.append(color)
        self.idx += [base, base + 1, base + 2]

    def box(self, cx, cy, cz, w, h, d, color):
        x0, x1, y0, y1, z0, z1 = cx - w / 2, cx + w / 2, cy - h / 2, cy + h / 2, cz - d / 2, cz + d / 2
        self.quad((x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1), color)  # +z
        self.quad((x1, y0, z0), (x0, y0, z0), (x0, y1, z0), (x1, y1, z0), color)  # -z
        self.quad((x1, y0, z1), (x1, y0, z0), (x1, y1, z0), (x1, y1, z1), color)  # +x
        self.quad((x0, y0, z0), (x0, y0, z1), (x0, y1, z1), (x0, y1, z0), color)  # -x
        self.quad((x0, y1, z1), (x1, y1, z1), (x1, y1, z0), (x0, y1, z0), color)  # top
        self.quad((x0, y0, z0), (x1, y0, z0), (x1, y0, z1), (x0, y0, z1), color)  # bottom

    def cylinder(self, cx, cy, cz, r, h, color, n=10):
        import math
        for i in range(n):
            a0, a1 = 2 * math.pi * i / n, 2 * math.pi * (i + 1) / n
            p0 = (cx + r * math.cos(a0), cz + r * math.sin(a0)); p1 = (cx + r * math.cos(a1), cz + r * math.sin(a1))
            self.quad((p1[0], cy - h / 2, p1[1]), (p0[0], cy - h / 2, p0[1]), (p0[0], cy + h / 2, p0[1]), (p1[0], cy + h / 2, p1[1]), color)
            self.tri((cx, cy + h / 2, cz), (p1[0], cy + h / 2, p1[1]), (p0[0], cy + h / 2, p0[1]), color)

    def hull(self, color, deck_color):
        """Pointed-bow hull, waterline at y=-0.3, deck at y=0.3."""
        y0, y1 = -0.3, 0.3
        outline = [(-0.55, -2.0), (0.55, -2.0), (0.62, 0.9), (0.5, 1.6), (0.25, 2.1), (0.0, 2.5),
                   (-0.25, 2.1), (-0.5, 1.6), (-0.62, 0.9)]   # (x, z), clockwise seen from above
        n = len(outline)
        for i in range(n):
            (xa, za), (xb, zb) = outline[i], outline[(i + 1) % n]
            self.quad((xa, y0, za), (xb, y0, zb), (xb, y1, zb), (xa, y1, za), color)
        c = (0.0, y1, 0.2)
        for i in range(n):
            (xa, za), (xb, zb) = outline[i], outline[(i + 1) % n]
            self.tri(c, (xb * 0.9, y1 + 0.001, zb), (xa * 0.9, y1 + 0.001, za), deck_color)
        c0 = (0.0, y0, 0.2)
        for i in range(n):
            (xa, za), (xb, zb) = outline[i], outline[(i + 1) % n]
            self.tri(c0, (xa, y0, za), (xb, y0, zb), color)


def build(kind, status):
    m = Mesh()
    hull = STATUS[status]
    deck = (0.17, 0.19, 0.21)
    m.hull(hull, deck)
    y = 0.3
    white, grey = (0.95, 0.95, 0.95), (0.62, 0.66, 0.70)
    m.box(0, y + 0.45, -1.45, 0.95, 0.9, 0.7, white)       # accommodation block
    m.box(0, y + 1.0, -1.45, 0.7, 0.12, 0.5, grey)          # bridge deck
    m.cylinder(0, y + 1.25, -1.72, 0.14, 0.45, hull)        # funnel
    if kind == "container":
        for i in range(4):
            z = -0.6 + i * 0.7
            m.box(0, y + 0.3, z, 0.95, 0.6, 0.62, PALETTE[i % 6])
            m.box(0, y + 0.78, z, 0.9, 0.36, 0.58, PALETTE[(i + 2) % 6])
            if i % 2 == 0:
                m.box(0, y + 1.1, z, 0.8, 0.28, 0.54, PALETTE[(i + 4) % 6])
    elif kind == "bulk":
        for i in range(4):
            m.box(0, y + 0.12, -0.55 + i * 0.7, 0.8, 0.24, 0.5, (0.45, 0.47, 0.50))
        for z in (-0.2, 0.85):
            m.box(0.52, y + 0.4, z, 0.06, 0.8, 0.06, (0.85, 0.85, 0.85))  # cranes
            m.box(0.3, y + 0.78, z, 0.5, 0.05, 0.05, (0.85, 0.85, 0.85))
    else:  # tanker
        m.box(0, y + 0.08, 0.3, 0.16, 0.12, 3.0, (0.73, 0.76, 0.78))
        for i in range(6):
            m.box(0, y + 0.08, -0.75 + i * 0.5, 0.7, 0.06, 0.06, (0.73, 0.76, 0.78))
        for i in range(3):
            m.cylinder(0, y + 0.2, -0.4 + i * 0.95, 0.13, 0.25, (0.86, 0.88, 0.9))
        m.box(0, y + 0.45, 2.0, 0.1, 0.5, 0.1, (0.85, 0.85, 0.85))  # bow mast
    return m


def write_glb(mesh, path):
    pos = b"".join(struct.pack("<3f", *p) for p in mesh.pos)
    nor = b"".join(struct.pack("<3f", *n) for n in mesh.nor)
    col = b"".join(struct.pack("<3f", *c) for c in mesh.col)
    idx = b"".join(struct.pack("<I", i) for i in mesh.idx)
    blob = pos + nor + col + idx
    xs, ys, zs = zip(*mesh.pos)
    nv = len(mesh.pos)
    doc = {
        "asset": {"version": "2.0", "generator": "oil-leaks generate_ship_models.py"},
        "scene": 0, "scenes": [{"nodes": [0]}], "nodes": [{"mesh": 0}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0, "NORMAL": 1, "COLOR_0": 2}, "indices": 3, "material": 0}]}],
        "materials": [{"pbrMetallicRoughness": {"baseColorFactor": [1, 1, 1, 1], "metallicFactor": 0.0, "roughnessFactor": 0.75}}],
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": nv, "type": "VEC3", "min": [min(xs), min(ys), min(zs)], "max": [max(xs), max(ys), max(zs)]},
            {"bufferView": 1, "componentType": 5126, "count": nv, "type": "VEC3"},
            {"bufferView": 2, "componentType": 5126, "count": nv, "type": "VEC3"},
            {"bufferView": 3, "componentType": 5125, "count": len(mesh.idx), "type": "SCALAR"},
        ],
        "bufferViews": [
            {"buffer": 0, "byteOffset": 0, "byteLength": len(pos), "target": 34962},
            {"buffer": 0, "byteOffset": len(pos), "byteLength": len(nor), "target": 34962},
            {"buffer": 0, "byteOffset": len(pos) + len(nor), "byteLength": len(col), "target": 34962},
            {"buffer": 0, "byteOffset": len(pos) + len(nor) + len(col), "byteLength": len(idx), "target": 34963},
        ],
        "buffers": [{"byteLength": len(blob)}],
    }
    js = json.dumps(doc, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    blob += b"\0" * (-len(blob) % 4)
    total = 12 + 8 + len(js) + 8 + len(blob)
    with open(path, "wb") as f:
        f.write(struct.pack("<4sII", b"glTF", 2, total))
        f.write(struct.pack("<I4s", len(js), b"JSON")); f.write(js)
        f.write(struct.pack("<I4s", len(blob), b"BIN\0")); f.write(blob)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for kind in ("tanker", "container", "bulk"):
        for status in STATUS:
            write_glb(build(kind, status), OUT / f"{kind}_{status}.glb")
    print("wrote", len(list(OUT.glob("*.glb"))), "models to", OUT)


if __name__ == "__main__":
    main()
