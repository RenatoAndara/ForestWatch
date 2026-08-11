"""ForestWatch: detecta pérdida de cobertura arbórea (GFW) para ubicaciones en CSV/WKT.

Sube un CSV con una columna de geometría en formato WKT (puntos o polígonos)
y la app consulta la Data API de Global Forest Watch (dataset Hansen/UMD
Tree Cover Loss) para indicar, por cada ubicación, si hubo pérdida de
cobertura arbórea desde 2021 hasta el último año disponible en el dataset.
"""
from __future__ import annotations

import io
import json
import os
import time

import folium
import pandas as pd
import streamlit as st
from dotenv import load_dotenv
from streamlit_folium import st_folium

from csv_utils import CsvColumnError, detect_columns
from geo_utils import GeometryParseError, geodesic_area_ha, parse_wkt, to_geojson
from gfw_client import GfwApiError, query_tree_cover_loss

load_dotenv()

START_YEAR = 2021
CANOPY_DENSITY_THRESHOLD = 30
POINT_BUFFER_M = 100
REQUEST_DELAY_S = 0.15

STATUS_LOSS = "Sí"
STATUS_NO_LOSS = "No"
STATUS_ERROR = "Error"

st.set_page_config(page_title="ForestWatch", layout="wide")


def get_api_key() -> str | None:
    key = os.environ.get("GFW_API_KEY", "").strip()
    return key or None


def read_uploaded_csv(uploaded_file) -> pd.DataFrame:
    raw = uploaded_file.read()
    for encoding in ("utf-8-sig", "utf-8", "latin-1"):
        try:
            return pd.read_csv(io.BytesIO(raw), encoding=encoding)
        except UnicodeDecodeError:
            continue
    raise ValueError("No se pudo leer el CSV con codificaciones utf-8 o latin-1.")


def analyze_row(row_id: str, wkt_text: str, api_key: str) -> tuple[dict, dict | None]:
    """Analiza una fila. Devuelve (fila_resultado, info_para_mapa | None)."""
    try:
        parsed = parse_wkt(wkt_text, POINT_BUFFER_M)
    except GeometryParseError as exc:
        return (
            {
                "id": row_id,
                "tipo_geometria": None,
                "area_analizada_ha": None,
                "perdida_arborea": STATUS_ERROR,
                "perdida_ha": None,
                "perdida_pct": None,
                "ultimo_anio_con_dato": None,
                "perdida_por_anio": None,
                "error": str(exc),
            },
            None,
        )

    try:
        result = query_tree_cover_loss(
            geometry=to_geojson(parsed.geometry),
            api_key=api_key,
            start_year=START_YEAR,
            canopy_density_threshold=CANOPY_DENSITY_THRESHOLD,
        )
    except GfwApiError as exc:
        return (
            {
                "id": row_id,
                "tipo_geometria": parsed.geometry_type,
                "area_analizada_ha": round(parsed.area_ha, 4),
                "perdida_arborea": STATUS_ERROR,
                "perdida_ha": None,
                "perdida_pct": None,
                "ultimo_anio_con_dato": None,
                "perdida_por_anio": None,
                "error": str(exc),
            },
            {"geometry": parsed.geometry, "status": "error"},
        )

    perdida_pct = (result.total_loss_ha / parsed.area_ha * 100) if parsed.area_ha else 0.0
    row_result = {
        "id": row_id,
        "tipo_geometria": parsed.geometry_type,
        "area_analizada_ha": round(parsed.area_ha, 4),
        "perdida_arborea": STATUS_LOSS if result.had_loss else STATUS_NO_LOSS,
        "perdida_ha": round(result.total_loss_ha, 4),
        "perdida_pct": round(perdida_pct, 2),
        "ultimo_anio_con_dato": result.last_year_with_data,
        "perdida_por_anio": json.dumps(result.loss_by_year, ensure_ascii=False) if result.loss_by_year else "",
        "error": "",
    }
    map_info = {"geometry": parsed.geometry, "status": "loss" if result.had_loss else "no_loss"}
    return row_result, map_info


def style_status(val: str) -> str:
    if val == STATUS_LOSS:
        return "background-color: #f8d7da; color: #842029;"
    if val == STATUS_NO_LOSS:
        return "background-color: #d1e7dd; color: #0f5132;"
    if val == STATUS_ERROR:
        return "background-color: #e2e3e5; color: #41464b;"
    return ""


def build_map(map_infos: list[dict]) -> folium.Map:
    colors = {"loss": "#c0392b", "no_loss": "#1e8449", "error": "#7f8c8d"}
    centroids = [(m["geometry"].centroid.y, m["geometry"].centroid.x) for m in map_infos]
    center = (
        (sum(c[0] for c in centroids) / len(centroids), sum(c[1] for c in centroids) / len(centroids))
        if centroids
        else (0, 0)
    )
    fmap = folium.Map(location=center, zoom_start=5, tiles="OpenStreetMap")
    for info in map_infos:
        color = colors[info["status"]]
        folium.GeoJson(
            to_geojson(info["geometry"]),
            style_function=lambda _feat, color=color: {
                "fillColor": color,
                "color": color,
                "weight": 2,
                "fillOpacity": 0.45,
            },
            tooltip=info.get("label", ""),
        ).add_to(fmap)
    if centroids:
        sw = (min(c[0] for c in centroids), min(c[1] for c in centroids))
        ne = (max(c[0] for c in centroids), max(c[1] for c in centroids))
        fmap.fit_bounds([sw, ne])
    return fmap


st.title("ForestWatch")
st.caption(
    "Detección de pérdida de cobertura arbórea desde 2021 a la fecha, usando la Data API de "
    "Global Forest Watch (dataset Hansen/UMD Tree Cover Loss)."
)

api_key = get_api_key()
if not api_key:
    st.error(
        "No se encontró la variable de entorno **GFW_API_KEY**. "
        "Crea un archivo `.env` en la raíz del proyecto (puedes copiar `.env.example`) "
        "con la línea `GFW_API_KEY=tu_api_key` y vuelve a iniciar la app."
    )
    st.stop()

with st.expander("Acerca de este análisis", expanded=False):
    st.markdown(
        f"""
- **Dataset**: Hansen/UMD Tree Cover Loss (`umd_tree_cover_loss`), vía GFW Data API.
- **Años analizados**: desde **{START_YEAR}** hasta el último año disponible en el dataset
  (se actualiza aproximadamente una vez al año, por lo que puede no incluir los meses más
  recientes del año en curso).
- **Umbral de densidad de copa**: **{CANOPY_DENSITY_THRESHOLD}%** (estándar GFW).
- **Puntos**: se analiza un buffer circular de **{POINT_BUFFER_M} m** alrededor de cada punto.
- **Polígonos**: se analizan tal cual, sin modificación.
        """
    )

st.subheader("1. Cargar CSV")
st.markdown(
    "El CSV debe tener una columna de geometría en formato **WKT** (ej. `POINT (-74.1 4.6)` o "
    "`POLYGON ((...))`), llamada `wkt` (o `geometria`/`geometry`/`geom`). "
    "Opcionalmente, una columna de identificador (`id`, `nombre`, `name`, etc.)."
)
uploaded_file = st.file_uploader("Selecciona un archivo CSV", type=["csv"])

if uploaded_file is None:
    st.info("Puedes usar `sample_data.csv` (incluido en el repositorio) para probar la app.")
    st.stop()

try:
    df = read_uploaded_csv(uploaded_file)
except ValueError as exc:
    st.error(str(exc))
    st.stop()

try:
    wkt_col, id_col = detect_columns(df)
except CsvColumnError as exc:
    st.error(str(exc))
    st.stop()

st.success(
    f"CSV cargado: {len(df)} fila(s). Columna WKT detectada: `{wkt_col}`. "
    f"Columna de identificador: `{id_col if id_col else '(se usará el número de fila)'}`."
)
st.dataframe(df.head(10), use_container_width=True)

st.subheader("2. Ejecutar análisis")
run_clicked = st.button("Analizar cobertura arbórea", type="primary")

if run_clicked:
    results = []
    map_infos = []
    progress = st.progress(0.0, text="Iniciando análisis...")
    total = len(df)

    for i, (_, row) in enumerate(df.iterrows()):
        row_id = str(row[id_col]) if id_col else f"Fila {i + 1}"
        wkt_text = row[wkt_col]
        result_row, map_info = analyze_row(row_id, wkt_text, api_key)
        results.append(result_row)
        if map_info is not None:
            map_info["label"] = f"{row_id}: {result_row['perdida_arborea']}"
            map_infos.append(map_info)
        progress.progress((i + 1) / total, text=f"Analizado {i + 1}/{total}: {row_id}")
        time.sleep(REQUEST_DELAY_S)

    progress.empty()
    st.session_state["results_df"] = pd.DataFrame(results)
    st.session_state["map_infos"] = map_infos

if "results_df" in st.session_state:
    results_df = st.session_state["results_df"]
    map_infos = st.session_state.get("map_infos", [])

    st.subheader("3. Resultados")
    n_total = len(results_df)
    n_loss = (results_df["perdida_arborea"] == STATUS_LOSS).sum()
    n_no_loss = (results_df["perdida_arborea"] == STATUS_NO_LOSS).sum()
    n_error = (results_df["perdida_arborea"] == STATUS_ERROR).sum()
    total_ha_lost = results_df["perdida_ha"].fillna(0).sum()

    c1, c2, c3, c4, c5 = st.columns(5)
    c1.metric("Ubicaciones", n_total)
    c2.metric("Con pérdida", int(n_loss))
    c3.metric("Sin pérdida", int(n_no_loss))
    c4.metric("Con error", int(n_error))
    c5.metric("Total ha perdidas", f"{total_ha_lost:,.2f}")

    styled = results_df.style.map(style_status, subset=["perdida_arborea"])
    st.dataframe(styled, use_container_width=True)

    csv_bytes = results_df.to_csv(index=False).encode("utf-8")
    st.download_button(
        "Descargar resultados (CSV)",
        data=csv_bytes,
        file_name="forestwatch_resultados.csv",
        mime="text/csv",
    )

    if map_infos:
        st.subheader("4. Mapa")
        st.caption("Rojo: con pérdida · Verde: sin pérdida · Gris: error al analizar")
        fmap = build_map(map_infos)
        st_folium(fmap, use_container_width=True, height=500, returned_objects=[])
