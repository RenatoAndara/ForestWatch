# MEMORIA TÉCNICA Y DESCRIPTIVA

**Autor:** Renato Andara · **Versión:** 2.0.0 (ver `CHANGELOG.md`)

## Sistema de Inspección, Validación de Integridad y Auto-Reparación de Archivos GeoJSON (RFC 7946 / EUDR / TRACES-NT)

---

### 1. Introducción y Antecedentes

El formato **GeoJSON** es el estándar de facto en la web para el intercambio de estructuras de datos geoespaciales simples. En sectores estratégicos como la agricultura de precisión, la gestión catastral y el comercio agroalimentario internacional, la precisión de las geometrías de las parcelas es fundamental.

Con la entrada en vigencia del **Reglamento sobre Productos Libres de Deforestación de la Unión Europea (EUDR - Regulation (EU) 2023/1115)** y la plataforma **TRACES-NT**, los operadores y productores están obligados a proporcionar polígonos de delimitación predial que cumplan con estándares rigurosos de topología y codificación. Geometrías con auto-intersecciones, lazos cruzados (*bowtie*), vértices redundantes o inconsistencias en la orientación de sus anillos pueden provocar el rechazo de las declaraciones de diligencia debida o errores en su procesamiento.

Este proyecto surge ante la necesidad de contar con una herramienta autónoma, interactiva y de alta precisión capaz de diagnosticar la integridad técnica de archivos GeoJSON, representar visualmente los linderos en mapas satelitales de alta resolución, detectar de forma matemática cualquier solapamiento interno o externo y ofrecer mecanismos de saneamiento y exportación de archivos conformes.

---

### 2. Marco Normativo y Especificaciones

#### 2.1. El Estándar RFC 7946 frente a GeoJSON 2008
El estándar original de GeoJSON fue redactado en 2008 por una comunidad informal de desarrolladores. En agosto de 2016, el **Internet Engineering Task Force (IETF)** publicó la especificación oficial bajo el estándar **RFC 7946**, reemplazando formalmente la versión anterior y subsanando ambigüedades topológicas.

#### 2.2. Sección 3.1.6 del RFC 7946: La Regla de la Mano Derecha (*Right-Hand Rule*)
El RFC 7946 estandariza la orientación de los anillos de coordenadas en geometrías de tipo `Polygon` y `MultiPolygon`:
- **Anillo exterior (límite perimetral):** Debe seguir obligatoriamente un orden en sentido **antihorario (counter-clockwise / CCW)**.
- **Anillos interiores (huecos o islas internas):** Deben seguir un orden en sentido **horario (clockwise / CW)**.

**Mecánica de la regla de la mano derecha:**
Si un observador camina a lo largo del perímetro siguiendo el orden secuencial de los vértices:
1. El interior del polígono debe quedar siempre a su **izquierda**.
2. En el perímetro exterior, caminar con el área interior a la izquierda equivale a rotar en sentido **antihorario**.
3. En un agujero interno, para que el área sólida rellena quede a la izquierda, debe rotar en sentido **horario**.

#### 2.3. Criterio de Clasificación: ALERTA frente a ERROR
El RFC 7946 §3.1.6 indica que, por compatibilidad con GeoJSON 2008, los analizadores **no deberían rechazar** polígonos que no sigan la regla de la mano derecha. Algunos sistemas sí exigen la orientación estricta, por lo que el sistema aplica esta política:
- **Orientación contraria a la regla de la mano derecha:** **ALERTA** (no bloqueante, corregible automáticamente).
- **Problemas de estructura, coordenadas o topología** (auto-intersecciones, espigas, puntos de contacto, anillos abiertos, vértices duplicados, huecos inválidos, solapamientos): **ERROR**.

> Nota: los requisitos concretos de cada plataforma (por ejemplo, el sistema de información EUDR) pueden cambiar; verifíquelos siempre en la documentación oficial vigente.

---

### 3. Caso de Estudio Real: Finca "Rancho Alegre"

> Los archivos `V19579584_RanchoAlegre_*.geojson` citados en esta sección no se incluyen en el paquete. Las pruebas automáticas usan ahora archivos sintéticos en `tests/fixtures/` que reproducen los mismos casos (auto-intersección, anillo válido, orientación horaria, etc.).

Para calibrar y validar los algoritmos implementados, se utilizó como banco de pruebas la finca productora **Rancho Alegre** (`PlotID: V19579584RANCHOALEGRE`, `NodeID: VE-PROC-RANCHOALEGRE`):

#### 3.1. Archivo con Solapamiento (`V19579584_RanchoAlegre_polygons.geojson`)
El archivo original presentaba un problema de integridad geométrica:
- **Total de vértices:** 20 coordenadas.
- **Comportamiento anómalo:** El vértice en el índice 18 (`[-71.747312, 7.934592]`) penetraba hacia el interior de la parcela y retornaba hacia el vértice de cierre 19 (`[-71.748272, 7.935860]`).
- **Punto de colisión / auto-intersección:** El segmento entre los vértices 2 y 3 colisionaba con el segmento entre los vértices 18 y 19 exactamente en la coordenada:
  $$\text{Longitud: } -71.748012, \quad \text{Latitud: } 7.935516$$
- **Consecuencia técnica:** Formación de un lazo auto-secante (*figure-8* o *bowtie*), lo cual invalida el polígono según las normas del Open Geospatial Consortium (OGC) y genera un **ERROR** en sistemas catastrales.

#### 3.2. Archivo Corregido (`V19579584_RanchoAlegre_polygons-new.geojson`)
En esta versión se suprimió el vértice errático índice 18, resultando en:
- **Total de vértices:** 19 coordenadas limpias y continuas.
- **Resultado de validación:** 0 auto-intersecciones, sin solapamientos, anillo cerrado y orientación antihoraria (CCW) plenamente conforme con el RFC 7946. Estado: **VÁLIDO ✅**.

---

### 4. Fundamentos Matemáticos y Algoritmos Implementados

#### 4.1. Algoritmo de Área con Signo (Fórmula de Shoelace / Polígono de Gauss)
Para evaluar la orientación del recorrido de los anillos se implementó la fórmula del área con signo en coordenadas cartesianas proyectadas:

$$\text{Área con signo} = \frac{1}{2} \sum_{i=0}^{n-1} \left( x_i y_{i+1} - x_{i+1} y_i \right)$$

Donde $x$ representa la Longitud e $y$ la Latitud:
- Si $\text{Área con signo} > 0 \implies$ El recorrido es **Antihorario (CCW)**.
- Si $\text{Área con signo} < 0 \implies$ El recorrido es **Horario (CW)**.

#### 4.2. Clasificación de Pares de Segmentos
Para dos segmentos $S_1=(A,B)$ y $S_2=(C,D)$ se calcula el signo de la orientación

$$o(P,Q,R) = (Q_x-P_x)(R_y-P_y) - (Q_y-P_y)(R_x-P_x)$$

con una tolerancia relativa de $10^{-10}$ (se considera 0 si $|o| \le 10^{-10}\,|PQ|\,|PR|$), para absorber el ruido de coma flotante.

- **Cruce propio:** $o(C,D,A)\cdot o(C,D,B) < 0$ y $o(A,B,C)\cdot o(A,B,D) < 0$. El punto se obtiene por determinantes (fórmula de intersección de rectas).
- **Superposición colineal:** las cuatro orientaciones son 0 y las proyecciones se solapan en más de un punto (bordes superpuestos o "espigas").
- **Contacto:** una orientación es 0 y el extremo cae dentro del otro segmento (puntos de contacto y vértices sobre borde).

Para evitar la comparación de todos contra todos ($O(n^2)$), los segmentos se ordenan por su $x$ mínima y solo se comparan los que se solapan en su caja envolvente (barrido por X).

**Solapamiento entre parcelas.** Dos polígonos se solapan si sus **interiores** se intersectan: existe un cruce propio entre sus bordes, o un vértice o punto medio de borde de uno cae estrictamente dentro del otro (descontando huecos). Compartir linderos o vértices no es solapamiento.

#### 4.3. Detección de Vértices Duplicados y Puntos de Contacto (*Pinch Points*)
- **Duplicados Consecutivos:** Pares adyacentes $(p_i, p_{i+1})$ tales que $p_i = p_{i+1}$, los cuales introducen segmentos nulos y distorsionan el cálculo de ángulos.
- **Puntos de Contacto (*Pinch Points*):** Vértices no adyacentes $(p_i, p_j)$ con idéntica coordenada geográfica que hacen que el polígono se toque a sí mismo sin cruzar bordes, dividiendo la superficie en múltiples lóbulos. Cada punto se reporta una sola vez.
- **Vértice sobre borde propio:** un vértice que toca el interior de otro borde del mismo anillo.
- **Espiga:** dos segmentos consecutivos colineales que retroceden sobre la misma línea.

#### 4.4. Cálculo Métrico
- **Perímetro:** fórmula de Haversine con el radio medio terrestre ($R = 6\,371\,008{,}8$ m).
- **Superficie:** área esférica de Chamberlain-Duquette con $R = 6\,378\,137$ m:
  $$A = \frac{R^2}{2}\left|\sum_i (\lambda_{i+1}-\lambda_i)\,(2+\sin\phi_i+\sin\phi_{i+1})\right|$$
  El área neta de un polígono es la del anillo exterior menos la de sus huecos.

> **Corrección v2:** la versión 1 dividía entre 4 en lugar de entre 2 y por tanto reportaba **la mitad** del área real; además ignoraba los huecos. Es un cálculo aproximado (esfera); para cifras oficiales use un SIG con el elipsoide WGS84.

---

### 5. Mecanismo de Auto-Reparación y Exportación

El módulo `GeoJSONRepairer` solo aplica correcciones que no alteran la forma de las parcelas:
1. **Cierre de anillos:** si el primer y último vértice difieren, se añade una copia del primero al final **sin eliminar ningún vértice** (la v1 descartaba el último vértice real).
2. **Purga de duplicados consecutivos**, incluido el duplicado inmediatamente anterior al cierre.
3. **Reversión de sentido:** exterior a antihorario (CCW), huecos a horario (CW).
4. **Estructura:** añade `"properties": {}` si falta y elimina el miembro `crs` cuando ya declara WGS84.
5. **Metadatos de trazabilidad (opcional):** bloque `"metadata"` con fecha y lista de cambios, desactivado por defecto porque algunos sistemas de carga podrían rechazar miembros adicionales.

Tras reparar, la interfaz **vuelve a validar** el resultado y lista los errores que requieren corrección manual (auto-intersecciones, solapamientos, coordenadas proyectadas).

---

### 6. Consideraciones de Compatibilidad y Ejecución Universal

1. **Carga nativa de archivos:** la zona de carga es un `<label for="file-input">`; el clic abre el selector del sistema de forma nativa (la v1 además llamaba a `click()` por código, lo que podía abrir el diálogo dos veces). Se admite arrastrar y soltar en toda la ventana.
2. **Ejecución con `file://` y `http://`:** los scripts son clásicos con envoltorio UMD (no módulos ES), por lo que funcionan con doble clic y también se cargan con `require()` en las pruebas de Node. Existe una única copia del motor.
3. **Leaflet local** en `vendor/`: el mapa interactivo funciona sin CDN; solo las imágenes base requieren internet. Si Leaflet no carga, se muestra una vista SVG.
4. **Motor Python equivalente** (`geojson_validator.py`) con línea de comandos; una prueba de paridad garantiza que produce los mismos diagnósticos que el motor del navegador.
