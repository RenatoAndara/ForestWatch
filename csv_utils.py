"""Detección flexible de columnas de id/nombre y WKT en el CSV cargado por el usuario."""
from __future__ import annotations

import pandas as pd

WKT_COLUMN_CANDIDATES = ["wkt", "geometria", "geometría", "geometry", "geom"]
ID_COLUMN_CANDIDATES = ["id", "nombre", "name", "identificador", "codigo", "código", "predio"]


class CsvColumnError(ValueError):
    """El CSV no tiene una columna WKT reconocible."""


def _find_column(columns: list[str], candidates: list[str]) -> str | None:
    lowered = {c.lower().strip(): c for c in columns}
    for candidate in candidates:
        if candidate in lowered:
            return lowered[candidate]
    return None


def detect_columns(df: pd.DataFrame) -> tuple[str, str | None]:
    """Devuelve (columna_wkt, columna_id_o_None)."""
    columns = list(df.columns)
    wkt_col = _find_column(columns, WKT_COLUMN_CANDIDATES)
    if wkt_col is None:
        raise CsvColumnError(
            "No se encontró una columna de geometría WKT. "
            f"Renombra la columna correspondiente a alguna de: {', '.join(WKT_COLUMN_CANDIDATES)}."
        )
    id_col = _find_column(columns, ID_COLUMN_CANDIDATES)
    return wkt_col, id_col
