# Registro de cambios — Revisor GeoJSON

**Autor:** Renato Andara

## 2.0.0 — 2026-11-12

### Errores corregidos
- **Área a la mitad:** la fórmula esférica dividía entre 4 en vez de entre 2; todas las áreas mostradas eran la mitad de la real. Además ahora se restan los huecos.
- **Reparar anillos abiertos perdía un vértice:** el último vértice real se descartaba al "cerrar" el anillo. Ahora se conservan todos.
- **Duplicado previo al cierre** (`…, A, P0, P0`) no se eliminaba al reparar.
- **Bloqueo con coordenadas inválidas:** una posición `null` o no numérica lanzaba una excepción y dejaba la interfaz congelada. Ahora se reporta como error y se omiten las comprobaciones que dependen de ella.
- **Inyección de HTML/JS:** `PlotID`, propiedades y mensajes se insertaban sin escapar en la tabla y en las ventanas del mapa; un archivo malicioso podía ejecutar código. Todo se escapa ahora.
- **Modo sin conexión roto:** `app.js` llamaba a `_renderFallbackData()`, que no existía en esa copia; sin internet la aplicación fallaba al dibujar.
- **Huecos ignorados:** una parcela dentro del hueco de otra se marcaba como solapada; un hueco fuera del polígono o que cruzaba el exterior no se detectaba.
- **Puntos de contacto reportados 3–4 veces** (uno por cada par de segmentos).
- **Mapa:** todas las parcelas se pintaban de rojo si había un solo error en el archivo; ahora cada una tiene su color. El mapa no se limpiaba al cargar un archivo con JSON inválido.
- **Selector de archivos** podía abrirse dos veces (label nativo + `click()` manual).
- **Flechas de dirección** con ángulo distorsionado lejos del ecuador (no corregían Mercator).
- **Python:** el resultado por JSON inválido usaba la clave `status` en vez de `overall_status`.
- **serve.py** escuchaba en todas las interfaces de red (exponía la carpeta a la red local); ahora solo `127.0.0.1`.

### Nuevas comprobaciones
- Espigas (retroceso colineal), bordes colineales superpuestos, vértice sobre borde propio, anillos degenerados.
- Huecos: intersección con otros anillos, fuera del exterior, huecos anidados.
- Solapamiento entre partes de un mismo MultiPolygon; detección de geometrías idénticas.
- Coordenadas proyectadas (UTM) o con latitud/longitud invertidas: el mensaje lo sugiere.
- Miembro `crs` obsoleto, identificadores duplicados, falta de `properties`, posiciones con más de 3 valores, FeatureCollection vacía, archivo vacío, BOM UTF-8.
- Precisión < 6 decimales y geometrías de punto (informativo, EUDR).
- GeometryCollection se valida miembro a miembro.

### Mejoras
- **Motor único:** se eliminó la copia duplicada del motor; los mismos archivos sirven al navegador (incluso con doble clic) y a las pruebas.
- **Rendimiento:** barrido por X en lugar de O(n²); 20 000 vértices en ~0,1 s, 3 600 parcelas colindantes en ~0,3 s. Números y flechas se desactivan por encima de 3000 vértices.
- **Leaflet incluido localmente** (`vendor/`): el mapa funciona sin CDN.
- **Interfaz:** pestaña *Entidades* (estado, vértices y área por parcela), buscador, contadores por pestaña, área total, leyenda, botón *Encuadrar*, escala, propiedades en la ficha de la parcela, arrastrar y soltar en toda la ventana, diseño adaptable a móvil.
- **Reportes** descargables en CSV (compatible con Excel en español) y JSON.
- **Reparación:** vuelve a validar el resultado y lista lo que requiere corrección manual; opción *Revisar el archivo reparado*; bloque `metadata` opcional (desactivado por defecto); elimina `crs` WGS84; añade `properties`.
- **Python:** motor equivalente con línea de comandos (`--reparar`, `--csv`, `--json`, varios archivos, códigos de salida).
- **Pruebas:** 27 pruebas JS (`node:test`) y suite Python con archivos compartidos en `tests/fixtures/` y prueba de **paridad** JS ↔ Python. Las pruebas originales dependían de archivos de Rancho Alegre que no estaban incluidos.
- Mensajes sobre EUDR/TRACES redactados con prudencia (se recomienda verificar requisitos vigentes).

## 1.0.0
Versión original recibida.
