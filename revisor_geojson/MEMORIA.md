# MEMORIA TÉCNICA Y DESCRIPTIVA

## Sistema de Inspección, Validación de Integridad y Auto-Reparación de Archivos GeoJSON (RFC 7946 / EUDR / TRACES-NT)

---

### 1. Introducción y Antecedentes

El formato **GeoJSON** es el estándar de facto en la web para el intercambio de estructuras de datos geoespaciales simples. En sectores estratégicos como la agricultura de precisión, la gestión catastral y el comercio agroalimentario internacional, la precisión de las geometrías de las parcelas es fundamental.

Con la entrada en vigencia del **Reglamento sobre Productos Libres de Deforestación de la Unión Europea (EUDR - Regulation (EU) 2023/1115)** y la plataforma **TRACES-NT**, los operadores y productores están obligados a proporcionar polígonos de delimitación predial que cumplan con estándares rigurosos de topología y codificación. Geometrías con auto-intersecciones, lazos cruzados (*bowtie*), vértices redundantes o inconsistencias en la orientación de sus anillos provocan el rechazo automático de las declaraciones de diligencia debida en los motores geoespaciales europeos.

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
El RFC 7946 estipula que los analizadores (*parsers*) permisivos no deben rechazar de plano polígonos con orientación inversa por razones de compatibilidad retrospectiva con GeoJSON 2008. Sin embargo, sistemas modernos y fiscalizadores como **TRACES/EUDR** y motores GIS avanzados exigen estricto cumplimiento para evitar ambigüedades en superficies esféricas globales. Por este motivo, el sistema implementa la siguiente política de diagnóstico:
- **Discrepancia en la Regla de la Mano Derecha (RFC 7946):** Se clasifica como **ALERTA (Advertencia no bloqueante)**.
- **Auto-intersecciones, bordes cruzados, vértices duplicados o errores de sintaxis:** Se clasifican como **ERROR CRÍTICO (Bloqueante)**.

---

### 3. Caso de Estudio Real: Finca "Rancho Alegre"

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

#### 4.2. Algoritmo de Intersección de Segmentos y Detección de Cruces
Para detectar auto-intersecciones entre segmentos de recta no contiguos $S_1 = (A, B)$ y $S_2 = (C, D)$, se empleó la prueba de orientación de giros en 2D basada en el producto cruzado vectorial:

$$\text{ccw}(P_1, P_2, P_3) = (y_3 - y_1)(x_2 - x_1) > (y_2 - y_1)(x_3 - x_1)$$

Dos segmentos se intersectan si y solo si:
$$\text{ccw}(A, C, D) \neq \text{ccw}(B, C, D) \quad \land \quad \text{ccw}(A, B, C) \neq \text{ccw}(A, B, D)$$

Cuando se confirma la colisión, la coordenada exacta del punto de cruce $(P_x, P_y)$ se resuelve mediante determinantes:

$$P_x = \frac{(x_1 y_2 - y_1 x_2)(x_3 - x_4) - (x_1 - x_2)(x_3 y_4 - y_3 x_4)}{(x_1 - x_2)(y_3 - y_4) - (y_1 - y_2)(x_3 - x_4)}$$

$$P_y = \frac{(x_1 y_2 - y_1 x_2)(y_3 - y_4) - (y_1 - y_2)(x_3 y_4 - y_3 x_4)}{(x_1 - x_2)(y_3 - y_4) - (y_1 - y_2)(x_3 - x_4)}$$

#### 4.3. Detección de Vértices Duplicados y Puntos de Contacto (*Pinch Points*)
- **Duplicados Consecutivos:** Pares adyacentes $(p_i, p_{i+1})$ tales que $p_i = p_{i+1}$, los cuales introducen segmentos nulos y distorsionan el cálculo de ángulos.
- **Puntos de Contacto (*Pinch Points*):** Vértices no adyacentes $(p_i, p_j)$ con idéntica coordenada geográfica que hacen que el polígono se toque a sí mismo sin cruzar bordes, dividiendo la superficie en múltiples lóbulos.

#### 4.4. Cálculo Métrico Geodésico
- **Perímetro Geodésico:** Calculado mediante la fórmula de Haversine sobre el radio medio terrestre ($R = 6,371,000 \text{ m}$):
  $$d = 2 R \arcsin \left( \sqrt{\sin^2\left(\frac{\Delta \phi}{2}\right) + \cos(\phi_1)\cos(\phi_2)\sin^2\left(\frac{\Delta \lambda}{2}\right)} \right)$$
- **Superficie Esférica:** Estimación geodésica del área en metros cuadrados y hectáreas utilizando la proyección sobre el elipsoide WGS84 ($R = 6,378,137 \text{ m}$).

---

### 5. Mecanismo de Auto-Reparación y Exportación

El módulo `GeoJSONRepairer` realiza correcciones automáticas no destructivas:
1. **Reversión de Sentido:** Si el anillo exterior posee orientación horaria (CW), invierte la secuencia del arreglo de coordenadas para transformarlo en antihorario (CCW). En huecos interiores, invierte de antihorario (CCW) a horario (CW).
2. **Purga de Duplicados:** Filtra vértices repetidos adyacentes preservando la topología de cierre ($p_0 = p_n$).
3. **Cierre de Anillos:** Restituye el vértice final si la distancia entre el primer y último punto difiere.
4. **Metadatos de Trazabilidad:** Inyecta en el objeto GeoJSON un bloque `"metadata"` con el sello de reparación, fecha y lista de correcciones realizadas.

---

### 6. Consideraciones de Compatibilidad y Ejecución Universal

Con el objetivo de garantizar una experiencia de usuario robusta y sin fricciones técnicas, se implementaron dos soluciones de diseño fundamentales:
1. **Disparador Nativo de Carga de Archivos (`<label for="file-input">`):** La zona de carga (*dropzone*) se estructuró semánticamente como una etiqueta HTML vinculada al control de entrada de archivos. Esto asegura que la ventana del explorador del sistema operativo se abra siempre de manera nativa al hacer clic sobre el recuadro, eliminando cualquier fallo por interceptación de eventos en el navegador.
2. **Ejecución Local Libre de Restricciones CORS:** Los motores de JavaScript fueron consolidados de forma autocontenida sin depender de módulos ES dinámicos (`type="module"`), lo que permite que la aplicación opere con total fluidez tanto al abrirse directamente desde el disco mediante el protocolo `file:///` (doble clic en `index.html`) como cuando es servida a través de un servidor HTTP local (`http://localhost:8000`).
3. **Interfaz Neutralizada y Enfocada en Datos Propios:** Se retiraron botones de pruebas predeterminadas del frontend para ofrecer un espacio de trabajo limpio, donde el usuario visualiza y procesa exclusivamente sus propios archivos prediales y catastrales.
