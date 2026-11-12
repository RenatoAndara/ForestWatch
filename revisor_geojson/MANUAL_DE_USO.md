# MANUAL DE USO Y OPERACIÓN

## Aplicación de Validación de Integridad, Diagnóstico Topológico y Visualización GeoJSON (RFC 7946 / EUDR)

---

### 1. Requisitos del Sistema

La aplicación es ligera y no requiere instalación de software pesado ni bases de datos:
- **Navegador Web Moderno:** Google Chrome, Microsoft Edge, Mozilla Firefox, Brave o Safari (con soporte para JavaScript ES6).
- **Entorno de Ejecución (Opcional para el servidor local):** Python 3.8 o superior (para ejecutar `serve.py`).
- **Conexión a Internet:** Necesaria únicamente para descargar los mosaicos de satélite de alta resolución (Esri) y mapas callejeros (OpenStreetMap). En caso de no tener internet, la aplicación continuará funcionando con el visor vectorial de respaldo.

---

### 2. Puesta en Marcha

#### Método A: Mediante Servidor Local en Python (Recomendado)
1. Abre tu terminal de comandos (PowerShell, CMD o Terminal de Linux/Mac).
2. Posiciónate en la carpeta del proyecto:
   ```powershell
   cd "c:\Users\randara\Downloads\Revisor archivos GeoJSON"
   ```
3. Ejecuta el comando:
   ```powershell
   python serve.py
   ```
4. El sistema iniciará el servidor en `http://localhost:8000` y abrirá automáticamente tu navegador web predeterminado.
5. Para cerrar el servidor cuando termines, presiona `Ctrl + C` en la terminal.

#### Método B: Apertura Directa en el Navegador
Si no dispones de Python instalado en el equipo:
1. Abre tu explorador de archivos y navega a la carpeta del proyecto.
2. Haz doble clic sobre el archivo **`index.html`** o arrástralo directamente a una pestaña de tu navegador web.

---

### 3. Recorrido por la Interfaz de Usuario

La pantalla principal se organiza en dos áreas de trabajo:

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ 📐 Validador GeoJSON                Archivo actual: ...   [🛠️ Reparar GeoJSON]│
├────────────────────────────────────────┬──────────────────────────────────────┤
│ 📂 ZONA DE ARRASTRE Y SELECCIÓN        │ 🛰️ VISOR CARTOGRÁFICO INTERACTIVO    │
│    (Haz clic aquí o arrastra archivo)  │                                      │
├────────────────────────────────────────┤  [x] Flechas CCW   [x] Vértices 1..N │
│ ESTADO DE INTEGRIDAD (Badge)           │                                      │
├────────────────────────────────────────┤  Mapa Satelital Esri / OSM           │
│ MÉTRICAS: Errores | Alertas | Parcelas │                                      │
├────────────────────────────────────────┤  Polígono resaltado (Verde/Rojo)     │
│ TABLA DE DIAGNÓSTICOS                  │  Marcador pulsante en cruce exacto   │
│ [Todos] [Errores] [Alertas]            │  Segmentos colisionantes iluminados  │
│ Lista con botón de centrado en mapa    │                                      │
└────────────────────────────────────────┴──────────────────────────────────────┘
```

1. **Cabecera Superior:** Muestra el nombre del archivo en análisis y el botón de acción principal **"Reparar y Exportar RFC 7946"**.
2. **Panel Lateral Izquierdo (Diagnóstico):**
   - **Zona de Carga (Dropzone Nativo):** Recuadro interactivo accesible tanto mediante clic directo (apertura nativa del explorador de archivos) como por arrastrar y soltar.
   - **Tarjeta de Estado Global:** Indicador visual resumido del estado del archivo (`VÁLIDO ✅`, `ALERTAS ⚠️`, `ERRORES ❌`).
   - **Contadores Métricos:** Total de errores críticos, alertas RFC 7946 y número de parcelas procesadas.
   - **Cuadro Informativo RFC 7946:** Referencia técnica a la regla de la mano derecha.
   - **Tabla de Diagnósticos:** Lista exhaustiva de hallazgos con filtrado por categoría y coordenadas exactas.
3. **Panel Central / Derecho (Visor Cartográfico):**
   - Contenedor interactivo del mapa con controles de capas (Satélite y Callejero).
   - Barra flotante de opciones: activar/desactivar flechas direccionales y numeración de vértices.

---

### 4. Carga e Inspección de Archivos

#### ¿Cómo cargar un archivo?
- **Haz clic en el recuadro:** Al hacer clic en cualquier parte del recuadro punteado con el icono 📂, se abrirá de inmediato la ventana del explorador de archivos de tu sistema operativo para seleccionar tu archivo `.geojson` o `.json`.
- **Arrastrar y Soltar:** Toma tu archivo GeoJSON desde cualquier carpeta o desde el escritorio y suéltalo dentro del recuadro.
- **Re-selección dinámica:** Puedes cargar nuevos archivos o volver a seleccionar el mismo archivo en cualquier momento; la interfaz limpiará el estado anterior y procesará la nueva entrada al instante.

Tan pronto el archivo es cargado, el mapa se encuadra y posiciona de forma automática sobre los linderos de la parcela.

---

### 5. Interpretación de Estados y Resultados

El sistema asigna un estado semántico global visible en la tarjeta de estado:

#### 🟢 COMPLETAMENTE VÁLIDO
- **Significado:** El archivo cumple estrictamente con el formato oficial GeoJSON, no contiene vértices duplicados ni auto-intersecciones de bordes, y su perímetro exterior está orientado en sentido antihorario (CCW) conforme a la regla de la mano derecha RFC 7946 §3.1.6.
- **Acción:** El archivo es apto para ser presentado ante plataformas estrictas como **TRACES-NT / EUDR**, catastros o SIG corporativos.

#### 🟡 VÁLIDO CON ALERTAS (Regla de la Mano Derecha RFC 7946)
- **Significado:** La geometría es topológicamente válida (anillo cerrado, sin bordes cruzados ni duplicados), pero el perímetro exterior sigue un sentido horario (CW) o los huecos internos siguen sentido antihorario (CCW).
- **Importante:** Según la especificación oficial RFC 7946, esta condición **no es un error sintáctico**, pero genera una **ALERTA** informativa porque normativas como el Reglamento de Deforestación de la UE (EUDR) exigen la orientación antihoraria para validar superficies en la esfera terrestre sin ambigüedad.
- **Acción recomendada:** Utilizar el botón *"Reparar y Exportar"* para corregir el orden de los anillos automáticamente.

#### 🔴 INVÁLIDO (ERRORES CRÍTICOS)
- **Significado:** El archivo contiene fallos que rompen la topología o la sintaxis:
  - *Auto-intersección / Solapamiento de bordes:* Segmentos de la línea perimetral se cruzan entre sí (forma de 8 o lazo).
  - *Vértices duplicados:* Dos o más coordenadas idénticas consecutivas.
  - *Anillo abierto:* El primer vértice no coincide con el último.
  - *Solapamiento inter-parcelas:* Dos parcelas independientes dentro del mismo archivo comparten área interior.
- **Acción obligatoria:** El archivo debe ser corregido antes de ser presentado ante cualquier organismo regulador.

---

### 6. Uso del Visor Cartográfico Interactivo

#### 6.1. Selección de Capas Cartográficas
En la esquina superior derecha del mapa, posa el cursor sobre el selector de capas para alternar entre:
- **🛰️ Satélite de Alta Resolución (Esri):** Permite verificar linderos sobre fotos satelitales reales, coberturas vegetales y cercas de la finca.
- **🗺️ Mapa Callejero (OpenStreetMap):** Permite ver vías de comunicación, nombres de caseríos y referencias geográficas.

#### 6.2. Inspección Visual de Solapamientos
Cuando el archivo analizado tiene un error de auto-intersección (como en `V19579584_RanchoAlegre_polygons.geojson`):
1. Aparecerá un **círculo rojo pulsante** exactamente sobre el punto donde los bordes se cortan (por ejemplo, en `[-71.748012, 7.935516]`).
2. Los dos segmentos de línea que chocan se iluminarán con un **trazo discontinuo fucsia brillante** para identificarlos de inmediato.
3. Al hacer clic sobre el marcador pulsante, se abrirá un globo informativo indicando los segmentos en conflicto.

#### 6.3. Centrado Rápido desde la Tabla de Diagnósticos
En la tabla del panel izquierdo, cada fila que contenga una coordenada incluye un botón azul con el icono 📍 (ejemplo: `📍 [-71.74801, 7.93552]`).
- Haz clic sobre ese botón para que la cámara del mapa realice un vuelo suave (*flyTo*) y haga zoom automático directamente sobre el punto exacto del problema.

#### 6.4. Flechas de Dirección y Números de Vértices
En la barra superior del mapa puedes marcar o desmarcar dos casillas útiles:
- **Flechas de Dirección (CCW/CW):** Muestra flechas celestes a lo largo del lindero. Si las flechas giran en sentido contrario a las manecillas del reloj, confirmas visualmente que cumple la regla de la mano derecha.
- **Números de Vértices (1..N):** Coloca una esfera numerada sobre cada punto del polígono. Esto facilita localizar en qué número de vértice se produjo una desviación (por ejemplo, el vértice errático #18).

#### 6.5. Ficha Técnica de la Parcela (Popup)
Haz clic dentro del polígono para desplegar su ficha emergente:
- **ID de Parcela:** Identificador (`PlotID` o nombre).
- **Código de Nodo:** Identificador de procesamiento (`NodeID`).
- **Área Estimada:** Superficie calculada en hectáreas (ha) y metros cuadrados (m²).
- **Perímetro:** Longitud perimetral total en metros.
- **Total de Vértices:** Cantidad de puntos que componen la geometría.

---

### 7. Guía de Auto-Reparación y Exportación

Si tu archivo presenta alertas de orientación (sentido horario CW) o vértices redundantes:

1. Haz clic en el botón verde superior **"🛠️ Reparar y Exportar RFC 7946"**.
2. Se abrirá una ventana emergente detallando las acciones aplicadas por el motor:
   - *Inversión de recorrido:* Ajuste automático a sentido antihorario (CCW).
   - *Eliminación de duplicados:* Supresión de vértices consecutivos repetidos.
   - *Aseguramiento de cierre:* Comprobación estricta del primer y último punto.
3. Haz clic en el botón **"💾 Descargar GeoJSON Corregido"**.
4. Tu navegador guardará el archivo saneado con el sufijo `_reparado_RFC7946.geojson`.
5. Si vuelves a cargar este nuevo archivo descargado en la aplicación, constatarás que su estado pasará a ser **COMPLETAMENTE VÁLIDO ✅**.

---

### 8. Preguntas Frecuentes y Solución de Problemas

#### ¿Por qué el archivo es rechazado en TRACES/EUDR si mi visor habitual lo abre sin problemas?
Muchos visores SIG básicos no verifican la orientación perimetral de los anillos de coordenadas (sección 3.1.6 del RFC 7946). Sin embargo, los sistemas de fiscalización satelital de la Unión Europea calculan la topología sobre la esfera terrestre WGS84 estricta; si el anillo está invertido, el sistema puede interpretar que la parcela es el "resto del planeta Tierra" en lugar del interior del polígono.

#### ¿La aplicación envía mis datos a servidores en la nube?
**No.** Todo el código se ejecuta en tu máquina local dentro de tu navegador web. Ningún dato geográfico o identificador predial sale de tu equipo.

#### ¿Cómo resuelvo un error de auto-intersección que el auto-reparador no elimina?
El auto-reparador corrige automáticamente orientaciones de anillos y duplicados adyacentes. Sin embargo, cuando un operario de campo o digitalizador trazó un punto anómalo que atraviesa el polígono (como el vértice 18 en `Rancho Alegre`), la aplicación te indica con exactitud las coordenadas y el número de vértice para que puedas retirarlo o ajustarlo en tu software SIG (QGIS / ArcGIS) con total precisión.
