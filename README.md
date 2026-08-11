# ForestWatch

Aplicación web (Streamlit) que carga un CSV con ubicaciones en formato **WKT**
(puntos o polígonos) y consulta la [Data API de Global Forest Watch
(GFW)](https://data-api.globalforestwatch.org/) para indicar, por cada
ubicación, si ha tenido **pérdida de cobertura arbórea desde 2021 hasta la
fecha**, cuántas hectáreas se perdieron y qué porcentaje del área representa.

## Cómo funciona

- **Dataset**: Hansen/UMD Tree Cover Loss (`umd_tree_cover_loss`), el dataset
  estándar de pérdida de cobertura arbórea de GFW. Se actualiza aproximadamente
  una vez al año, por lo que "a la fecha" queda limitado al último año que GFW
  haya publicado (la app te muestra ese año en la columna
  `ultimo_anio_con_dato`).
- **Umbral de densidad de copa**: 30% (el estándar que usa la plataforma web
  de GFW).
- **Puntos**: se analiza un buffer circular de 100 m alrededor del punto
  (proyectado a la zona UTM correspondiente para que el radio sea preciso en
  metros).
- **Polígonos**: se analizan directamente, sin modificación.
- **Geometrías mixtas**: la app detecta el tipo de geometría fila por fila.

## Requisitos

- Python 3.10+
- Una API Key de GFW (la generas en https://www.globalforestwatch.org/ , en tu
  perfil → "My GFW" → API keys).

## Instalación

```bash
python -m venv .venv
source .venv/bin/activate  # En Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

## Configuración de la API Key

**Nunca pongas tu API Key directamente en el código ni la subas a git.**

1. Copia `.env.example` a `.env`:
   ```bash
   cp .env.example .env
   ```
2. Edita `.env` y reemplaza el valor de ejemplo:
   ```
   GFW_API_KEY=tu_api_key_real
   ```

El archivo `.env` está incluido en `.gitignore`, así que no se subirá al
repositorio.

> **Nota de seguridad**: si en algún momento compartiste tu API Key en un
> chat, documento o repositorio público, considera regenerarla desde tu
> perfil de GFW.

## Ejecutar la app

```bash
streamlit run app.py
```

Se abrirá en `http://localhost:8501`.

## Formato del CSV de entrada

Columnas esperadas:

| Columna | Obligatoria | Descripción |
|---|---|---|
| `wkt` (o `geometria`/`geometry`/`geom`) | Sí | Geometría en formato WKT: `POINT (lon lat)` o `POLYGON ((...))` |
| `id` (o `nombre`/`name`/`identificador`/`codigo`/`predio`) | No | Identificador de la ubicación. Si no existe, se usa el número de fila. |

Ejemplo (`sample_data.csv` incluido en el repo):

```csv
id,wkt
Predio Amazonia Norte,"POLYGON ((-70.05 -3.10, -70.00 -3.10, -70.00 -3.05, -70.05 -3.05, -70.05 -3.10))"
Punto Chocó,"POINT (-76.85 5.55)"
```

**Importante**: en WKT las coordenadas van como `X Y`, es decir
`longitud latitud` (no al revés).

## Resultados

Por cada ubicación se muestra:

- `tipo_geometria`: tipo de geometría analizada (punto con buffer, polígono, etc.)
- `area_analizada_ha`: hectáreas del área analizada
- `perdida_arborea`: `Sí` / `No` / `Error`
- `perdida_ha`: hectáreas de pérdida de cobertura arbórea desde 2021
- `perdida_pct`: porcentaje del área analizada que se perdió
- `ultimo_anio_con_dato`: último año con datos de pérdida disponibles en GFW
- `perdida_por_anio`: desglose año a año (JSON), para quien lo necesite
- `error`: detalle del error, si lo hubo (WKT inválido, fallo de la API, etc.)

Los resultados se pueden descargar como CSV y se visualizan en un mapa
(rojo = con pérdida, verde = sin pérdida, gris = error).

## Límites conocidos

- Geometrías muy grandes o muy complejas pueden exceder los límites de
  consulta síncrona de la GFW Data API. Si esto ocurre, la fila quedará
  marcada con `Error` y el detalle del problema.
- La API de GFW aplica límites de tasa (rate limiting) por API Key; para CSVs
  muy grandes el análisis puede tardar varios minutos.
