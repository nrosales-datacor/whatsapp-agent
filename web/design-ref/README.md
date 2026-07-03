# Handoff: Lavacar Rosales — Inbox de WhatsApp + Panel de métricas

## Overview
Aplicación web con dos módulos para un negocio de lavado de autos:
1. **Inbox** tipo WhatsApp Web/CRM para gestionar chats de clientes (bot + humano).
2. **Panel** de métricas de negocio (KPIs, citas, servicios, horas pico).

Incluye dos direcciones visuales exploradas (ver sección "Variantes"), modo claro/oscuro, y datos de ejemplo en colones (₡) para un lavacar en Costa Rica.

## About the Design Files
Los archivos `.dc.html` de esta carpeta son **prototipos de referencia** construidos en HTML — muestran look, contenido y comportamiento intencionados, **no son código de producción para copiar tal cual**. La tarea es **recrear este diseño en el stack real del proyecto** (React, Vue, backend de WhatsApp Business API, etc.) usando sus patrones y librerías existentes — o, si no hay stack aún, elegir el framework más adecuado.

Abrí los `.dc.html` en un navegador para verlos funcionando (son interactivos: click en chats, filtros, envío de mensajes, toggle bot/humano, cambio de tema).

## Fidelity
**Alta fidelidad (hifi):** colores, tipografía, espaciado e interacciones están definidos como finales. Se debe recrear pixel-perfect, adaptando al sistema de diseño/librerías del proyecto destino.

## Variantes visuales exploradas
Dos direcciones de color sobre la misma estructura (mismo componente, prop `variant`):
- **Verde "Lavacar"** (`variant="verde"`, default): cálido, estilo WhatsApp. Acento `#0b7d72` (light) / `#37b3a3` (dark). Header `#0b5c56`.
- **Azul "Datacor"** (`variant="azul"`): corporativo, más denso. Acento `#248DE3` (light) / `#4aa3ea` (dark). Header `#103050`.

Elegir una sola dirección para producción (recomendado: confirmar con el cliente antes de implementar).

## Screens / Views

### 1. Inbox
**Propósito:** el operador ve todos los chats de WhatsApp, filtra por bot/humano/sin responder, responde manualmente o deja que el bot atienda, y dispara acciones rápidas (agendar cita, cotizar, marcar atendido).

**Layout:**
- Header fijo, 60px alto, fondo `--c-header-bg` (verde `#0b5c56` / azul `#103050`), color texto `--c-header-fg`.
  - Izquierda: logo cuadrado 34×34px radius 10px con iniciales "LR", nombre del negocio (Noto Sans 800, 15.5px) + subtítulo (11px, color atenuado).
  - Centro-izquierda: tabs segmentadas "Inbox" / "Panel" en un contenedor con fondo `rgba(255,255,255,.10)`, radius 11px, padding 4px. Tab activa: fondo `--c-header-fg`, texto `--c-header-bg`. Badge de no leídos en tab Inbox (círculo naranja `--c-warning`).
  - Derecha: botón notificaciones (con punto naranja), botón modo claro/oscuro (ícono luna/sol), botón "Salir".
- Debajo del header: layout de 2 columnas, `flex: 1`.
  - **Sidebar** (350px fijo, fondo `--c-surface`, borde derecho 1px `--c-border`):
    - Buscador (input 40px alto, ícono lupa, radius 10px, fondo `--c-surface-2`).
    - Fila de 4 filtros tipo pill (Todos / Bot / Humano / Sin resp.) con contador; filtro activo con fondo `--c-accent`.
    - Lista scrolleable de conversaciones. Cada fila (padding 12×14px, borde inferior 1px):
      - **Score**: tile cuadrado 44×44px, radius `--c-av` (13px light / 999px azul), número en Noto Sans 800. Color según score: ≥80 fondo sólido acento; 55-79 fondo acento suave; <55 gris neutro.
      - Número de teléfono (Noto Sans, 700 si no leído / 600 si leído, 14px).
      - Hora del último mensaje (11px, acento si no leído).
      - Preview del último mensaje (12.5px, truncado a ~34 caracteres con "…").
      - Badge **BOT** (verde/acento) o **HUMANO** (naranja) — 10px, mayúsculas, tracking .05em, pill.
      - Fila seleccionada: borde izquierdo 3px acento + fondo `--c-active`.
  - **Panel de conversación** (flex 1, fondo `--c-chat-bg` con patrón de puntos sutil):
    - Header del chat (56px aprox, fondo `--c-surface`): score tile 42px, teléfono (700, 15.5px), badge bot/humano, badge "Cita agendada" si aplica (pill verde con ícono calendario), subtítulo (servicio + "Lead score N/100"), botón toggle canal (bot↔humano) a la derecha.
    - Área de mensajes: burbujas con máx 74% ancho.
      - Mensaje del **cliente**: alineado izquierda, fondo `--c-bubble-in` (blanco / gris oscuro en dark), radius 16px con esquina inferior-izq 4px.
      - Mensaje del **negocio**: alineado derecha, fondo `--c-bubble-out` (verde/azul pálido), radius 16px con esquina inferior-der 4px. Lleva una etiqueta pequeña arriba ("Bot" o "Agente", 10px bold, con ícono) en color acento o naranja según quién respondió.
      - Timestamp 10px debajo del texto, alineado a la derecha.
      - Separador "Hoy" centrado arriba, pill con sombra.
    - Barra de acciones rápidas (encima del input): 3 botones pill —
      - **Agendar cita** (relleno, color acento, ícono calendario)
      - **Enviar cotización** (outline, ícono documento)
      - **Marcar atendido** (outline, check verde)
    - Input de mensaje: textarea auto-resize (44-96px), radius 14px, botón enviar circular 44×44px relleno acento con ícono flecha.
    - Estado vacío (sin chat seleccionado): ícono chat centrado en card 96×96px, texto invitando a elegir una conversación.

### 2. Panel (Dashboard)
**Propósito:** dueño/operador ve el desempeño del negocio de un vistazo.

**Layout:** contenido centrado, máx 1120px, fondo `--c-bg`.
- Encabezado: eyebrow "PANEL · LAVACAR ROSALES" (11.5px, uppercase, tracking .08em) + H1 "Resumen operativo" (Noto Sans 800, 27px) + chip "Últimos 7 días · San José" con punto verde de estado.
- **4 KPI cards** en grid `repeat(4, 1fr)`, gap 16px. Cada card (padding 18px, radius 16px, borde 1px, sombra suave):
  - Label (12.5px, gris) + ícono en badge cuadrado 32px (fondo acento suave).
  - Valor grande (Noto Sans 900, 34px).
  - Delta con ícono de tendencia (12px, verde éxito).
  - KPIs: Conversaciones (42), Citas agendadas (11), Conversión (26%), Ingresos estimados (₡ 312 500).
- **Citas por día**: card con barras horizontales, una fila por día (etiqueta 84px + barra + número), barra en color acento, altura 14px, radius pill.
- **Grid 2 columnas** (gap 16px):
  - **Servicios más pedidos**: ranking con número en badge circular + barra horizontal delgada (9px) por servicio, intensidad de color decreciente por rank.
  - **Horas pico**: barras verticales (8 franjas horarias), altura proporcional, etiqueta de hora rotada -32°, número arriba de cada barra.

## Interactions & Behavior
- Click en fila de conversación → selecciona y marca como leída.
- Búsqueda filtra por teléfono o texto del último mensaje (en vivo, sin debounce necesario a este volumen).
- Filtros (Todos/Bot/Humano/Sin resp.) son excluyentes, cuentan resultados en vivo.
- Botón toggle canal: alterna `channel` entre `bot` y `humano` en la conversación seleccionada; dispara un toast de confirmación.
- Enviar mensaje (botón o Enter sin Shift): agrega burbuja "negocio" con tag "Agente", cambia el canal de la conversación a humano, limpia el input.
- "Agendar cita": agrega mensaje automático de confirmación, marca `appointment: true` (aparece badge en el header del chat), cambia a canal humano, dispara toast.
- "Enviar cotización": agrega mensaje con precios, cambia a canal humano, dispara toast.
- "Marcar atendido": limpia el estado de no leído, dispara toast.
- Toast: aparece abajo-centro, auto-descarta a los ~3.2s o con botón X. Sin animación de entrada obligatoria (se probó que las animaciones de entrada podían dejar contenido invisible tras un re-render — usar transiciones o mantenerlo simple).
- Botón sol/luna en el header alterna variables de tema (ver Design Tokens) para toda la app.

## State Management
- Lista de conversaciones (array): `id, phone, score, channel (bot|humano), unread, appointment, service, messages[]`.
- Cada mensaje: `from (cliente|negocio), by (bot|humano|null), text, t (hora formateada)`.
- Estado de UI: `view (inbox|panel)`, `mode (light|dark)`, `selectedId`, `filter`, `search`, `draft` (texto en composición), `toast`.
- Datos del dashboard (KPIs, citas por día, servicios, horas pico) pueden venir de un endpoint de analítica — en el prototipo son estáticos/mock.

## Design Tokens

### Colores — variante Verde (default)
Modo claro:
- Fondo app `#e9efec` · Superficie `#ffffff` · Superficie alterna `#f4f8f6`
- Texto primario `#0f2723` · Texto secundario `#5e716c` · Texto terciario `#9aaaa4`
- Borde `#e3ebe7`
- Acento `#0b7d72` · Acento suave `#d6efe9` · Texto sobre acento `#ffffff`
- Header fondo `#0b5c56` · Header texto `#eafcf6`
- Burbuja entrante `#ffffff` · Burbuja saliente `#d4f2e7`
- Bot `#0b7d72` / fondo bot `#d6efe9` · Humano `#b5620a` / fondo humano `#fbe6cf`
- Éxito `#58BE4D` · Advertencia `#FA8500` · Peligro `#C72B3F`
- Radius base 16px / pequeño 10px

Modo oscuro:
- Fondo `#0a1614` · Superficie `#0f1f1c` · Texto `#e7f1ee` · Texto secundario `#9db4ae`
- Acento `#37b3a3` · Header fondo `#0b201d`
- Burbuja entrante `#17302b` · Burbuja saliente `#0f463f`

### Colores — variante Azul
Modo claro: fondo `#eef2f7`, acento `#248DE3` (Medium Blue de Datacor), header `#103050` (Datacor Blue). Radius más chato (10 / 8px, avatares circulares).
Modo oscuro: fondo `#080f1a`, acento `#4aa3ea`, header `#0a1626`.

### Tipografía
- Display/headings: **Noto Sans** (pesos 400/500/600/700/800/900), incluida en `/fonts`.
- Body/UI: **Roboto** (Google Fonts, pesos 300/400/500/700).
- Tamaños clave: KPI value 34px/900 · H1 panel 27px/800 · nombre negocio 15.5px/800 · mensaje 14px/400 · labels 11-12.5px/500-700.

### Espaciado y sombra
- Radios: 16px (cards/burbujas), 10px (inputs/botones pequeños), 999px (pills/avatares).
- Sombra estándar: `0 1px 2px rgba(15,39,35,.05), 0 10px 30px rgba(15,39,35,.06)` (ajustar rgb según tema).

## Assets
- Íconos: set propio inline (SVG sprite, estilo stroke 1.6–2.2px, redondeado) — nombres: search, send, cal, quote, check2, bell, moon, sun, chat, dash, out, bot, user, x, trend, money, clock. Si el equipo usa una librería de íconos (ej. Lucide), mapear 1:1 por nombre/forma.
- Fuentes Noto Sans: carpeta `/fonts` (TTF).
- Sin fotografías/logos reales — el logo "LR" es un placeholder tipográfico.

## Files
- `LavacarApp.dc.html` — componente principal con toda la lógica (Inbox + Panel), prop `variant` (`verde` | `azul`).
- `Lavacar Rosales (options canvas).dc.html` — lienzo que muestra ambas variantes lado a lado para comparación.
- `/fonts` — Noto Sans TTFs usados por el prototipo.

No se necesita el archivo HTML "standalone" (bundle offline) para el handoff de desarrollo — es pesado a propósito porque incrusta fuentes y runtime en base64 solo para verlo sin conexión. Para implementación, usar únicamente los archivos listados arriba como referencia visual/funcional.
