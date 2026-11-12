# MANUAL DE USO — Revisor GeoJSON

**Autor:** Renato Andara · **Versión:** 2.0.0

Aplicación local para validar, visualizar y reparar archivos GeoJSON según RFC 7946, reglas topológicas (OGC) y buenas prácticas para declaraciones EUDR.

---

## 1. Requisitos

- **Navegador moderno:** Chrome, Edge, Firefox, Brave o Safari recientes.
- **Python 3.8+** (opcional): solo para `serve.py` o para la línea de comandos.
- **Internet** (opcional): solo para las imágenes base (satélite Esri y OpenStreetMap). Leaflet viene incluido en `vendor/`, así que el mapa, las geometrías, los marcadores y la validación funcionan sin conexión. Si Leaflet no pudiera cargarse, se muestra una vista vectorial SVG simplificada.

## 2. Puesta en marcha

**Opción A — doble clic:** abre `index.html` en el navegador. Funciona directamente desde el disco (`file://`).

**Opción B — servidor local:**

```bash
python serve.py
```

Abre `http://localhost:8000` (o el siguiente puerto libre). El servidor solo acepta conexiones desde el propio equipo. Opciones: `--port 9000`, `--no-browser`. Detener con `Ctrl+C`.

**Opción C — línea de comandos (sin interfaz):**

```bash
python geojson_validator.py parcelas.geojson
```

```bash
python geojson_validator.py parcelas.geojson --reparar parcelas_ok.geojson --csv reporte.csv
```

Otras opciones: `--json` (resultado completo), `--info` (mostrar mensajes informativos), `--metadata` (añadir registro de cambios al reparar). Admite varios archivos a la vez. Código de salida: `0` sin errores, `1` con errores, `2` archivo ilegible — útil para automatizar revisiones.

## 3. Interfaz

| Zona | Contenido |
|---|---|
| Cabecera | Nombre y tamaño del archivo, botones **CSV**, **JSON** (reportes) y **Reparar y exportar**. |
| Zona de carga | Clic para elegir archivo, o arrastrar y soltar en cualquier parte de la ventana. |
| Estado | VÁLIDO / VÁLIDO CON ALERTAS / INVÁLIDO, cuántas entidades tienen errores y tiempo de análisis. |
| Métricas | Errores, alertas, número de entidades y área total (ha). |
| Pestañas | Todos · Errores · Alertas · Info · **Entidades** (lista de parcelas con estado, vértices y área). Buscador de texto. |
| Mapa | Cada parcela coloreada según **su** estado (verde, ámbar, rojo). Marcadores en el punto exacto de cada problema, segmentos en conflicto resaltados, flechas de dirección, números de vértice, botón **Encuadrar**, escala. |

**Navegación:** clic en una fila con coordenadas → el mapa vuela a ese punto. Clic en una entidad → encuadra la parcela y abre su ficha (área, perímetro, vértices, errores, propiedades).

En archivos con más de 3000 vértices, los números y flechas se desactivan automáticamente para que el navegador no se congele (se indica con un aviso).

## 4. Qué se revisa

### ❌ Errores (el archivo debe corregirse)

| Categoría | Qué significa |
|---|---|
| Sintaxis JSON / Estructura GeoJSON / Estructura Feature | El archivo no es JSON válido, o no sigue la estructura GeoJSON. |
| Geometría Nula / Inválida / Vacía, Tipo de Geometría | Falta la geometría o está mal formada. |
| Coordenada Inválida | Posiciones que no son `[longitud, latitud]` numéricas. |
| Límites WGS84 | Coordenadas fuera de ±180 / ±90. El mensaje sugiere si parecen **proyectadas (UTM)** o con **lat/lon invertidas**. |
| Vértices Insuficientes / Anillo Abierto / Anillo Degenerado | Anillo con menos de 4 posiciones, primer ≠ último vértice, o sin superficie. |
| Vértices Duplicados Consecutivos | Dos posiciones idénticas seguidas (se corrige con *Reparar*). |
| Auto-intersección / Bordes Colineales Superpuestos | Bordes del mismo anillo que se cruzan (forma de "8") o se superponen. |
| Espiga / Retroceso de Borde | El borde va y vuelve por la misma línea. |
| Punto de Auto-Contacto / Vértice sobre Borde Propio | El anillo se toca a sí mismo en un punto. |
| Intersección entre Anillos / Hueco fuera del Exterior / Huecos Solapados | Problemas de los huecos (anillos interiores). |
| Solapamiento Inter-Parcelas | Dos parcelas comparten **superficie**. Compartir linderos o vértices (parcelas colindantes) **no** es solapamiento. Las parcelas dentro del hueco de otra tampoco. |
| Solapamiento entre Partes | Partes del mismo MultiPolygon que se superponen. |

### ⚠️ Alertas (válido, pero conviene revisar)

| Categoría | Qué significa |
|---|---|
| Regla de la Mano Derecha (RFC 7946) | Exterior horario o hueco antihorario. RFC 7946 §3.1.6 pide exterior antihorario y huecos horarios, pero también indica que los lectores no deben rechazar geometrías que no lo cumplan. Algunos sistemas sí lo exigen. Se corrige con *Reparar*. |
| Sistema de Referencia (crs) | El miembro `crs` es de GeoJSON 2008; RFC 7946 lo eliminó y exige WGS84. |
| Identificador Duplicado | El mismo `PlotID`/`id` aparece en varias entidades. |
| Estructura Feature | Falta el miembro `properties`. |
| Dimensiones de Coordenadas | Posiciones con más de 3 valores. |

### ℹ️ Información

- **Precisión de Coordenadas:** todas las coordenadas de la entidad tienen menos de 6 decimales (≈ 0,1 m). Para EUDR se suelen pedir 6 decimales; **verifique el requisito vigente** en la documentación oficial.
- **Geometrías de Punto:** recordatorio de que, en EUDR, las parcelas de más de 4 ha deben declararse como polígono (verifique la normativa vigente).
- Resumen de cuántos anillos exteriores cumplen la regla de la mano derecha.

## 5. Reparación automática

1. Pulse **Reparar y exportar**.
2. La ventana muestra los cambios aplicados y **vuelve a validar** el resultado:
   - Verde: el archivo reparado es válido.
   - Rojo: quedan errores que **no** se pueden corregir automáticamente (auto-intersecciones, solapamientos, coordenadas proyectadas…). Se listan para corregirlos en un SIG.
3. **Descargar GeoJSON corregido** guarda `<nombre>_reparado_RFC7946.geojson`.
4. **Revisar el archivo reparado** lo carga en la aplicación para inspeccionarlo.

Correcciones automáticas (no cambian la forma de las parcelas): cerrar anillos abiertos sin perder vértices, eliminar duplicados consecutivos, orientar anillos (exterior CCW, huecos CW), añadir `properties: {}` si falta, eliminar `crs` cuando ya declara WGS84.

La casilla **Añadir bloque `metadata`** (desactivada por defecto) agrega el registro de cambios al archivo. RFC 7946 permite miembros adicionales, pero algunos sistemas de carga podrían rechazarlos; por eso es opcional.

## 6. Reportes

- **CSV:** una fila por diagnóstico (nivel, categoría, entidad, mensaje, longitud, latitud). Separador `;` y codificación UTF-8 con BOM para abrir directamente en Excel en español.
- **JSON:** resultado completo, incluido el resumen por entidad (estado, área, perímetro, vértices).

## 7. Preguntas frecuentes

**¿Se envían mis datos a algún servidor?** No. El análisis se hace en tu navegador. Solo se descargan las imágenes del mapa base (Esri / OpenStreetMap) para la zona que estás viendo.

**¿Cómo corrijo una auto-intersección?** Use las coordenadas y los números de segmento/vértice del diagnóstico para localizar el punto en su SIG (QGIS, ArcGIS) y mover o eliminar el vértice. En QGIS también existe *Vectorial → Herramientas de geometría → Corregir geometrías*, aunque conviene revisar el resultado porque puede partir el polígono.

**El área de mi parcela difiere un poco de la de mi SIG.** La aplicación calcula un área esférica aproximada (radio WGS84). Para parcelas agrícolas la diferencia con un cálculo elipsoidal suele ser pequeña (del orden de décimas de punto porcentual), pero el valor oficial debe obtenerse con su SIG.

**¿Por qué mis parcelas colindantes no aparecen como solapadas?** Porque compartir un lindero no es solapamiento: solo se reporta cuando las superficies se superponen.

## 8. Pruebas (para mantenimiento)

```bash
npm test
```

```bash
python -m unittest discover -s tests -v
```

Ambas suites usan los mismos archivos de `tests/fixtures/`. La suite de Python incluye una prueba de paridad que compara, mensaje por mensaje, los resultados de Python con los del motor JavaScript (requiere Node.js).
