# Undermania — Laboratorio Universitario de Piano & Lector MIDI / MSCZ

**Undermania** es una aplicación de lectura y práctica de piano de nivel universitario con cascada de notas interactiva, pentagrama sincronizado en clave de Sol y Fa, detección de errores en tiempo real y soporte nativo para teclados MIDI y archivos `.mid` y `.mscz`.

## Paleta de Colores Oficial
- **Principal:** `#00FFFF` (Cyan)
- **Secundario:** `#6C439C` (Púrpura)
- **Terciario:** `#BD8FCC` (Lavanda)

## Características Implementadas

1. **Modo de Práctica Avanzado**
   - **Espera de Nota Interactiva:** Las notas se detienen en la línea de ejecución y no avanzan hasta que el estudiante presiona las notas correspondientes en su teclado MIDI (o teclado/ratón).
   - **Separación de Manos:** Práctica independiente de **Mano Derecha**, **Mano Izquierda** o **Ambas Manos** (la mano no activa se reproduce automáticamente como acompañamiento).
   - **Velocidad por Porcentaje:** Control continuo desde `25%` hasta `200%` y botones rápidos (`50%`, `75%`, `100%`, `125%`, `150%`).
   - **Bucles A–B (Loops):** Selección de puntos `A` y `B` en la canción para repetir pasajes complejos de forma continua.

2. **Visualizaciones y Lectura Académica**
   - **Solfeo dentro de cada nota en caída:** Muestra `Do`, `Re`, `Mi`, `Fa`, `Sol`, `La`, `Si` con selector de alteraciones en sostenidos (`#`) o bemoles (`b`).
   - **Digitación Opcional (`1` al `5`):** Indicadores numéricos sobre las notas indicando qué dedo utilizar (`1` pulgar a `5` meñique), activable o desactivable en cualquier momento.
   - **Pentagrama con Desplazamiento Horizontal o Salto Automático de Página:** Selector en tiempo real entre desplazamiento continuo horizontal o paginación automática según la posición del cursor.

3. **Análisis de Ejecución en Tiempo Real**
   - **Detección de Errores en el Pentagrama:** Resalta en **Verde** (`#00E676`) las notas acertadas y dibuja en **Rojo** (`#FF3366`) las notas equivocadas directamente sobre el pentagrama.
   - **Barra de Precisión de Timing:** Medidor en milisegundos (`-150 ms` Antes $\leftrightarrow$ `0 ms` Perfecto $\leftrightarrow$ `+150 ms` Después) que indica si estás presionando antes o después del pulso exacto.

4. **Conectividad MIDI y Formatos `.mid` / `.mscz`**
   - Conexión directa con teclados MIDI USB/Bluetooth mediante Web MIDI API.
   - Lectura nativa de archivos estándar MIDI (`.mid`, `.midi`) y partituras de MuseScore comprimidas (`.mscz`) o sin comprimir (`.mscx`).

## Ejecución Rápida

```bash
python3 server.py
```

Luego abre en tu navegador (Chrome / Edge / Opera con soporte WebMIDI):
`http://127.0.0.1:8080`
