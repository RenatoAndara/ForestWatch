"""Cliente delgado para la Data API de Global Forest Watch (GFW).

Consulta el dataset de pérdida de cobertura arbórea de Hansen/UMD
(umd_tree_cover_loss) para una geometría dada, usando SQL sobre ráster
tal como lo soporta la GFW Data API.

Referencia: https://data-api.globalforestwatch.org/
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field

import requests

GFW_DATA_API_BASE = "https://data-api.globalforestwatch.org"
DATASET = "umd_tree_cover_loss"
DATASET_VERSION = "latest"
REQUEST_TIMEOUT_S = 60


class GfwApiError(Exception):
    """Error al consultar la GFW Data API."""


@dataclass
class TreeCoverLossResult:
    loss_by_year: dict[int, float] = field(default_factory=dict)

    @property
    def total_loss_ha(self) -> float:
        return sum(self.loss_by_year.values())

    @property
    def had_loss(self) -> bool:
        return self.total_loss_ha > 0

    @property
    def last_year_with_data(self) -> int | None:
        return max(self.loss_by_year) if self.loss_by_year else None


def _build_sql(start_year: int, canopy_density_threshold: int) -> str:
    return (
        "SELECT umd_tree_cover_loss__year, SUM(area__ha) AS loss_area_ha "
        "FROM data "
        f"WHERE umd_tree_cover_loss__year >= {int(start_year)} "
        f"AND umd_tree_cover_density_2000__percent >= {int(canopy_density_threshold)} "
        "GROUP BY umd_tree_cover_loss__year"
    )


def query_tree_cover_loss(
    geometry: dict,
    api_key: str,
    start_year: int = 2021,
    canopy_density_threshold: int = 30,
    max_retries: int = 3,
) -> TreeCoverLossResult:
    """Consulta hectáreas de pérdida de cobertura arbórea por año para una geometría.

    Lanza GfwApiError si la API responde con un error no recuperable o si se
    agotan los reintentos (por ejemplo, ante límites de tasa/429).
    """
    url = f"{GFW_DATA_API_BASE}/dataset/{DATASET}/{DATASET_VERSION}/query"
    payload = {
        "sql": _build_sql(start_year, canopy_density_threshold),
        "geometry": geometry,
    }
    headers = {"x-api-key": api_key, "Content-Type": "application/json"}

    last_error: Exception | None = None
    for attempt in range(1, max_retries + 1):
        try:
            response = requests.post(url, json=payload, headers=headers, timeout=REQUEST_TIMEOUT_S)
        except requests.RequestException as exc:
            last_error = exc
            time.sleep(2 * attempt)
            continue

        if response.status_code == 200:
            body = response.json()
            rows = body.get("data") or []
            loss_by_year = {
                int(row["umd_tree_cover_loss__year"]): float(row["loss_area_ha"] or 0)
                for row in rows
                if row.get("umd_tree_cover_loss__year") is not None
            }
            return TreeCoverLossResult(loss_by_year=loss_by_year)

        if response.status_code == 429:
            last_error = GfwApiError("Límite de tasa alcanzado (429) en la GFW Data API")
            time.sleep(2 * attempt)
            continue

        if response.status_code == 401:
            raise GfwApiError(
                "GFW API respondió 401 (no autorizado). Revisa que tu GFW_API_KEY sea válida."
            )

        raise GfwApiError(f"GFW API respondió {response.status_code}: {response.text[:500]}")

    raise GfwApiError(f"No se pudo consultar la GFW Data API tras {max_retries} intentos: {last_error}")
