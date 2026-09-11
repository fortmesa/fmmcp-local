"""One-time asset-authoring script (NOT part of the build pipeline — its OUTPUT,
media/fortmesa-icons.woff, is what gets committed and read at runtime) for the
VS Code status-bar icon (`contributes.icons`, D-U2 — the status bar can only
render text + icon-font glyphs, never arbitrary SVG). Committed here (rather
than left in a scratch directory) so the binary asset is reproducible/auditable
— re-run with `python3 scripts/build-icon-font.py` from the repo root whenever
the source mark changes.

The glyph is a FAITHFUL, FULL reproduction of the ingested brand mark
(media/logo.svg, fetched from https://fortmesa.com/.well-known/logo.svg) — a
brand mark that must not be modified: every element is preserved (the ring, the
crenellated tower with its flag, the base bar, and the two banner flares). It is
NOT a simplification.

A font glyph fills by the NON-ZERO winding rule, but logo.svg is almost entirely
STROKES (fill=none, stroke=…), which have no interior to fill. So each stroked
path is converted to filled geometry by true STROKE-TO-OUTLINE expansion, then
emitted as filled contours; because same-wound overlapping contours union under
non-zero winding, no boolean-geometry library is needed (shapely/picosvg are
absent from this hermetic pod — only numpy + fontTools are available):

  • ring (circle stroke)      → concentric outer/inner circles (a true annulus);
                                the inner circle is the ONE opposite-wound hole.
  • flag (filled path)        → its outline as a filled contour, verbatim.
  • base bar + crenellations  → per-segment quads + miter join fills (the mark
    (miter-join strokes)        specifies miter joins, miterlimit 25).
  • banner flares             → clean two-sided offset ribbons with round joins
    (round-join cubic strokes)  (per-segment quads fray at these curves'
                                degenerate end tangent; the offset ribbon does
                                not).

Uses fontTools (a system package on this pod — `python3 -c "import fontTools"` —
not a new project dependency, not fetched from the network) and numpy purely as
one-time authoring tools, the same way a designer would use Illustrator/
FontForge once to produce a binary asset that then ships as a static file.
"""

import math
from pathlib import Path

import numpy as np
import xml.etree.ElementTree as ET
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.svgLib.path import parse_path
from fontTools.ttLib import TTFont

UPM = 1000
# Fill ~94% of the em, baseline-aligned — matching VS Code's codicon convention
# (measured: codicon UPM 300, ascent 300 / descent 0, glyphs sit on the baseline
# and rise to ~94% of the em). This makes the mark occupy the full status-bar
# cell — taller than the adjacent caps — instead of floating mid-em with padding.
FILL = 940  # content long-side, in font units
NSEG = 28  # cubic-bezier flattening resolution
JOIN_THRESH_DEG = 8.0  # below this turn angle, a join fill is a sub-pixel no-op — skip it
GLYPH_NAME = "fortmesa"
CODEPOINT = 0xE901  # low Private Use Area codepoint (IcoMoon/VS Code convention), deliberately BELOW the codicon PUA range (0xEA01+) so it cannot collide with a built-in codicon. Bumped E900->E901 to bust VS Code's per-codepoint glyph cache when the mark is redrawn (VS Code keeps rendering the previously-rasterized glyph for a given codepoint even after the .woff on disk changes).

SVG_PATH = Path(__file__).resolve().parent.parent / "media" / "logo.svg"
OUT_PATH = Path(__file__).resolve().parent.parent / "media" / "fortmesa-icons.woff"


# ---------- geometry helpers ----------
def unit(v):
    n = np.linalg.norm(v)
    return v / n if n > 1e-12 else v * 0.0


def perp(d):
    return np.array([-d[1], d[0]])


def signed_area(pts):
    a = 0.0
    n = len(pts)
    for i in range(n):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % n]
        a += x1 * y2 - x2 * y1
    return a / 2.0


def force_winding(pts, positive):
    """Orient pts so its signed area is >0 (positive=True) or <0 (positive=False)."""
    if (signed_area(pts) > 0) != positive:
        return pts[::-1]
    return pts


def circle_pts(cx, cy, r, sides):
    return [np.array([cx + r * math.cos(2 * math.pi * k / sides), cy + r * math.sin(2 * math.pi * k / sides)]) for k in range(sides)]


def disk(c, r, sides=16):
    return [c + r * np.array([math.cos(2 * math.pi * k / sides), math.sin(2 * math.pi * k / sides)]) for k in range(sides)]


def line_intersect(P, d1, Q, d2):
    cr = d1[0] * d2[1] - d1[1] * d2[0]
    if abs(cr) < 1e-9:
        return None
    diff = Q - P
    t = (diff[0] * d2[1] - diff[1] * d2[0]) / cr
    return P + t * d1


def seg_quad(P, Q, hw):
    n = perp(unit(Q - P))
    return [P + hw * n, Q + hw * n, Q - hw * n, P - hw * n]


def dedupe(points, tol=1e-6):
    out = [points[0]]
    for p in points[1:]:
        if np.linalg.norm(p - out[-1]) > tol:
            out.append(p)
    return out


def stroke_quads(points, hw, join, miterlimit, closed):
    """A stroked polyline as same-wound filled polygons: one quad per segment
    (butt-capped) plus a miter/round fill at each turning vertex. Robust for the
    rectilinear, sharp-cornered parts of the mark (base bar, crenellations)."""
    points = dedupe(points)
    n = len(points)
    if n < 2:
        return []
    polys = [seg_quad(points[i], points[i + 1], hw) for i in range(n - 1)]
    if closed and n >= 3:
        polys.append(seg_quad(points[-1], points[0], hw))
    verts = range(n) if closed else range(1, n - 1)
    for i in verts:
        prev, cur, nxt = points[(i - 1) % n], points[i % n], points[(i + 1) % n]
        a, b = unit(cur - prev), unit(nxt - cur)
        if np.linalg.norm(a) == 0 or np.linalg.norm(b) == 0:
            continue
        if math.degrees(math.acos(float(np.clip(a @ b, -1.0, 1.0)))) < JOIN_THRESH_DEG:
            continue
        na, nb = perp(a), perp(b)
        if a[0] * b[1] - a[1] * b[0] > 0:  # left turn -> outer is right side
            A, B = cur - hw * na, cur - hw * nb
        else:
            A, B = cur + hw * na, cur + hw * nb
        if join == "round":
            polys.append(disk(cur, hw))
            continue
        M = line_intersect(A, a, B, b)
        polys.append([cur, A, B] if M is None or np.linalg.norm(M - cur) > miterlimit * hw else [cur, A, M, B])
    return polys


def stroke_offset(points, hw, miterlimit=4.0):
    """A smooth (round-join) open stroke as one clean two-sided offset ribbon:
    left side forward + right side back, butt end caps. Used for the banner
    flares, where per-segment quads fray at the curves' degenerate end tangent."""
    points = dedupe(points, tol=0.75)  # drop bunched near-coincident tail points
    n = len(points)
    if n < 2:
        return []
    segdir = [unit(points[i + 1] - points[i]) for i in range(n - 1)]
    norms = []
    for i in range(n):
        if i == 0:
            norms.append(perp(segdir[0]))
        elif i == n - 1:
            norms.append(perp(segdir[-1]))
        else:
            m = perp(segdir[i - 1]) + perp(segdir[i])
            ml = np.linalg.norm(m)
            if ml < 1e-6:
                norms.append(perp(segdir[i]))
            else:
                m = m / ml
                denom = float(m @ perp(segdir[i]))
                norms.append(m * min(1.0 / denom if abs(denom) > 1e-3 else 1.0, miterlimit))
    left = [points[i] + hw * norms[i] for i in range(n)]
    right = [points[i] - hw * norms[i] for i in range(n)]
    return [left + right[::-1]]


# ---------- flattening pen ----------
class FlattenPen:
    """Records an SVG path (via fontTools' parse_path) as flattened polylines,
    one per subpath, each tagged open/closed."""

    def __init__(self, nseg=NSEG):
        self.subs = []  # list of [points, closed]
        self._pts = None
        self.nseg = nseg

    def moveTo(self, p):
        self._pts = [np.array(p, float)]
        self.subs.append([self._pts, False])

    def lineTo(self, p):
        self._pts.append(np.array(p, float))

    def curveTo(self, *pts):
        p0 = self._pts[-1]
        q = [np.array(x, float) for x in pts]
        if len(q) == 3:  # cubic
            c1, c2, e = q
            for i in range(1, self.nseg + 1):
                t = i / self.nseg
                mt = 1 - t
                self._pts.append(mt**3 * p0 + 3 * mt**2 * t * c1 + 3 * mt * t**2 * c2 + t**3 * e)
        elif len(q) == 2:  # quadratic
            c, e = q
            for i in range(1, self.nseg + 1):
                t = i / self.nseg
                mt = 1 - t
                self._pts.append(mt**2 * p0 + 2 * mt * t * c + t**2 * e)
        else:
            self._pts.append(q[-1])

    def qCurveTo(self, *pts):
        p0 = self._pts[-1]
        q = [np.array(x, float) for x in pts]
        if len(q) == 2:
            c, e = q
            for i in range(1, self.nseg + 1):
                t = i / self.nseg
                mt = 1 - t
                self._pts.append(mt**2 * p0 + 2 * mt * t * c + t**2 * e)
        else:
            self._pts.append(q[-1])

    def closePath(self):
        self.subs[-1][1] = True

    def endPath(self):
        pass


def flatten(d):
    pen = FlattenPen()
    parse_path(d, pen)
    return pen.subs


# ---------- SVG -> filled contours ----------
def parse_svg():
    """Walk media/logo.svg and return (solids, holes) as lists of point-lists in
    the SVG's own coordinate space. Style (stroke/fill/width/join) is inherited
    down the tree, so the crenellation <g>'s stroke-width/miterlimit apply to its
    child paths."""
    root = ET.parse(SVG_PATH).getroot()
    solids, holes = [], []

    def walk(el, style):
        st = dict(style)
        for k in ("stroke", "fill", "stroke-width", "stroke-linejoin", "stroke-miterlimit", "stroke-linecap"):
            if el.get(k) is not None:
                st[k] = el.get(k)
        tag = el.tag.split("}")[-1]
        if tag == "circle":
            cx, cy, r = float(el.get("cx")), float(el.get("cy")), float(el.get("r"))
            if st.get("stroke", "none") != "none":
                hw = float(st.get("stroke-width", 1)) / 2.0
                solids.append(circle_pts(cx, cy, r + hw, 128))
                holes.append(circle_pts(cx, cy, r - hw, 128))
            if st.get("fill", "none") != "none":
                solids.append(circle_pts(cx, cy, r, 128))
        elif tag == "path":
            subs = flatten(el.get("d"))
            if st.get("fill", "none") != "none":
                for pts, _closed in subs:
                    solids.append(pts)
            if st.get("stroke", "none") != "none":
                hw = float(st.get("stroke-width", 1)) / 2.0
                join = st.get("stroke-linejoin", "miter")
                ml = float(st.get("stroke-miterlimit", 4))
                for pts, closed in subs:
                    if join == "round" and not closed:
                        solids.extend(stroke_offset(pts, hw))
                    else:
                        solids.extend(stroke_quads(pts, hw, join, ml, closed))
        for child in el:
            walk(child, st)

    walk(root, {})
    return solids, holes


def notdef_glyph():
    pen = TTGlyphPen(None)
    box = [(50, 0), (450, 0), (450, 700), (50, 700)]
    pen.moveTo(box[0])
    for pt in box[1:]:
        pen.lineTo(pt)
    pen.closePath()
    return pen.glyph()


def main():
    solids, holes = parse_svg()

    allpts = [p for c in solids + holes for p in c]
    xs, ys = [p[0] for p in allpts], [p[1] for p in allpts]
    minx, maxx, miny, maxy = min(xs), max(xs), min(ys), max(ys)
    W, H = maxx - minx, maxy - miny
    cxr = (minx + maxx) / 2.0
    s = FILL / max(W, H)

    def xf(p):  # scale; center horizontally in the advance; sit on the baseline (y-flip: SVG y-down -> font y-up)
        return (round(UPM / 2 + (p[0] - cxr) * s), round((maxy - p[1]) * s))

    pen = TTGlyphPen(None)
    for contours, positive in ((solids, True), (holes, False)):
        for c in contours:
            pts = force_winding([xf(p) for p in c], positive)  # solids one way, holes opposite
            pen.moveTo(pts[0])
            for p in pts[1:]:
                pen.lineTo(p)
            pen.closePath()
    glyph = pen.glyph()

    fb = FontBuilder(UPM, isTTF=True)
    fb.setupGlyphOrder([".notdef", GLYPH_NAME])
    fb.setupCharacterMap({CODEPOINT: GLYPH_NAME})
    fb.setupGlyf({".notdef": notdef_glyph(), GLYPH_NAME: glyph})
    fb.setupHorizontalMetrics({".notdef": (500, 0), GLYPH_NAME: (UPM, 0)})
    # Baseline at the em bottom, ascent = full em (codicon convention) so the
    # baseline-aligned glyph fills the whole cell rather than a sub-band.
    fb.setupHorizontalHeader(ascent=UPM, descent=0)
    fb.setupNameTable({"familyName": "fortmesa-icons", "styleName": "Regular"})
    fb.setupOS2(
        sTypoAscender=UPM,
        sTypoDescender=0,
        usWinAscent=UPM,
        usWinDescent=0,
        # fontTools' setupOS2 defaults fsType to 4 ("Preview & Print embedding"
        # only) — a DRM-style restriction for licensed commercial fonts. Wrong
        # for a font we author and ship ourselves; 0 = Installable Embedding.
        fsType=0,
    )
    fb.setupPost()
    fb.font.flavor = "woff"
    fb.save(str(OUT_PATH))
    print(f"Wrote {OUT_PATH}")

    # Structural sanity check: reload and confirm the glyph + cmap round-trip.
    check = TTFont(str(OUT_PATH))
    assert check["cmap"].getBestCmap()[CODEPOINT] == GLYPH_NAME, "cmap mapping did not round-trip"
    assert check["OS/2"].fsType == 0, "fsType did not round-trip as Installable Embedding"
    g = check["glyf"][GLYPH_NAME]
    print(f"Glyph bbox: ({g.xMin}, {g.yMin}) - ({g.xMax}, {g.yMax}), contours: {g.numberOfContours}")
    assert g.numberOfContours >= 10, f"expected many contours (full mark reproduction), got {g.numberOfContours}"
    assert g.xMin >= 0 and g.yMin >= 0 and g.xMax <= UPM and g.yMax <= UPM, "glyph bbox unexpectedly exceeds the em square"
    assert g.yMax >= 0.90 * UPM, f"glyph should fill ~94% of the em height (codicon-style); yMax={g.yMax}"
    print("Structural sanity check passed.")


if __name__ == "__main__":
    main()
