"""Metric projection for geometry math done in metres."""


def utm_crs_sql(lon_expr: str) -> str:
    """SQL for the CRS of the northern-hemisphere UTM zone containing longitude
    `lon_expr`, e.g. `'EPSG:32618'` for NYC and `'EPSG:32617'` for Miami.

    Project a line and every point measured against it with the same zone
    (pick it from the line), so they share one metric frame even when they
    straddle a zone boundary. UTM is conformal and its scale error stays under
    0.1% inside a zone, so lengths and offsets come out true to the metre.
    """
    return f"('EPSG:' || (32601 + LEAST(floor(({lon_expr} + 180) / 6), 59))::INTEGER)"
