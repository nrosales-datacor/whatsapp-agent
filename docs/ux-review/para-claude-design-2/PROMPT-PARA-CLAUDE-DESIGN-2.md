# Prompt para Claude Design — Parte 2 (pantallas restantes)

> **Importante: seguí en la MISMA conversación de Claude Design donde ya definiste el sistema de
> diseño premium** (bandeja, dashboard, chat, ficha, mi negocio, agenda). Este es el segundo lote:
> **aplicá exactamente el mismo sistema** (tokens de color con acento configurable, tipografía,
> espaciado, elevación/sombras, estilo de tarjetas/botones/inputs/pills/tablas, tratamiento claro y
> oscuro) a las pantallas que faltaron. No reinventes el estilo: buscamos **consistencia total** con
> lo que ya hiciste.
>
> Si estás en una conversación nueva, primero pegá el sistema de diseño que definiste en la parte 1
> (paleta/tokens, tipografía, componentes) y recién después seguí con esto.
>
> Adjunto 10 capturas de esta carpeta (`docs/ux-review/para-claude-design-2/`). Recordá el contexto:
> panel SaaS white-label de un **agente de WhatsApp con IA para lavacars** en Costa Rica; dos roles
> (operador / dueño); se usa mucho desde el **celular**; copy en **español de CR** (voseo); acento de
> color **configurable por negocio** (nada hardcodeado); **tema claro y oscuro**; en móvil la
> navegación es **bottom nav**. Es rediseño visual/UX, no features nuevas de backend.

---

## Qué incluye este lote

**A. Pantallas nuevas (nunca las diseñaste):**

1. **Login** (`01-login-desktop-claro.png`, `14-login-movil-claro.png`)
   - Es la primera impresión del producto y debe sentirse **premium y confiable** desde el segundo
     cero. Hoy es un formulario básico. Quiero jerarquía, marca bien presentada, y que se sienta
     como el acceso a una herramienta seria (tipo el login de Linear/Stripe), cuidando el móvil.

2. **Modal "Nueva cita"** (`07-agenda-nueva-cita-desktop-claro.png`, `20-agenda-nueva-cita-movil-claro.png`)
   - Formulario para agendar una cita a mano (cliente, servicio, fecha/hora, placa, precio). Mejorá
     el orden del formulario, el agrupamiento de campos y que sea cómodo de llenar **en el teléfono**
     (selects, date/time pickers con buen área de toque). Debe verse parte del mismo sistema del
     modal "Ficha del cliente".

**B. Completar la matriz responsive / dark de pantallas ya diseñadas** (mostrame cómo se ven en
estas variantes, con el sistema ya definido):

3. **Chat en móvil** (`16-chat-conversacion-movil-claro.png`) — el chat ocupa toda la pantalla; ojo
   con el header (estado del bot + acciones rápidas), las burbujas y el campo de escribir con el
   bottom nav / teclado.
4. **Chat en oscuro** (`12-chat-conversacion-desktop-oscuro.png`) — que el modo oscuro se sienta rico
   e intencional, no un claro invertido.
5. **Ficha del cliente en móvil** (`17-ficha-cliente-movil-claro.png`) — el modal a pantalla casi
   completa; jerarquía entre datos, historial de servicios y notas privadas.
6. **Dashboard en móvil** (`18-dashboard-movil-claro.png`) — cómo colapsan las tarjetas de KPI y el
   gráfico en una columna sin perder jerarquía (recordá: agrupar métricas de dinero / conversión /
   riesgo, números tabulares).
7. **Agenda en móvil** (`19-agenda-movil-claro.png`) — vista de día/semana usable en pantalla chica.

**C. Dos pantallas de administración que NO pude capturar pobladas** (requieren base de datos, en la
demo salen con estado de error/vacío). Te paso una captura del "shell" (`09-usuarios-desktop-claro.png`,
que muestra header + estado actual) y **te especifico abajo la estructura real** para que las diseñes
pobladas. Campañas usa el mismo shell/nav; diseñá ambas con el mismo lenguaje de tablas + formularios.

### C.1 — Usuarios (solo la ve el dueño)

Gestión del equipo del negocio. Estructura:
- **Tarjeta "Equipo (N)"** con una **tabla**: columnas **Usuario** (marca "(vos)" al usuario actual),
  **Rol** (select: Dueño / Operador), **Estado** (Activo / Inactivo), **Acciones** (botón
  Desactivar/Reactivar). El usuario actual no puede cambiarse el rol ni desactivarse a sí mismo
  (controles deshabilitados). Estado vacío: "Todavía no hay usuarios".
- **Tarjeta "Agregar usuario"**: formulario en línea con inputs **usuario**, **contraseña** (tipo
  password), **select de rol** (Operador / Dueño) y botón **"+ Agregar usuario"**.
- Diseñá: tabla premium legible (roles y estado con tratamiento visual claro — p. ej. rol como pill,
  estado con color semántico sobrio), acciones destructivas bien señaladas, y cómo colapsa la tabla
  en **móvil** (cards apiladas en vez de tabla horizontal).

### C.2 — Campañas (solo la ve el dueño)

Marketing por WhatsApp a segmentos del CRM. Estructura:
- **Tarjeta "Historial (N)"** con **tabla**: columnas **Nombre**, **Estado** (badge:
  Borrador / Programada / Enviando / Completada / Cancelada), **Destinatarios**, **Creada**,
  **Acciones** (Ver detalle). Estado vacío: "Todavía no armaste ninguna campaña".
- **Tarjeta "Nueva campaña"**: campos **Nombre** (interno), **Mensaje** (textarea con contador
  x/300), y un **constructor de segmento**: un select con 3 opciones — *Todos los clientes* /
  *Inactivos hace N+ días* / *Se hicieron un servicio hace N+ meses* — que muestra inputs
  adicionales según la opción (días, o servicio + meses), un botón **Previsualizar** (devuelve
  "Este segmento tiene N clientes") y un botón **Crear como borrador**.
- **Modal "Detalle de campaña"**: badge de estado + mensaje, una **grilla de métricas**
  (Destinatarios, Enviados, Fallidos, Omitidos por baja, Respuestas, Citas generadas) y, si está en
  borrador, una sección **"Confirmar envío"** (checkbox "Programar para más tarde" + datetime) con
  botón **Enviar ahora / Programar envío**, más **Cancelar campaña**.
- Diseñá: los **badges de estado** como parte del sistema (5 estados con color semántico), el
  constructor de segmento claro (que no intimide a un dueño no técnico), la grilla de métricas del
  detalle con jerarquía (números tabulares), y la versión **móvil** de tabla → cards.

---

## Qué quiero de vos

1. **Mockups** de: Login (desktop + móvil), Modal Nueva cita (desktop + móvil), Chat (móvil +
   oscuro), Ficha móvil, Dashboard móvil, Agenda móvil, **Usuarios** (poblada, desktop + móvil) y
   **Campañas** (poblada: historial + nueva campaña + modal de detalle, desktop + móvil).
2. Que todo use **el mismo sistema de diseño** de la parte 1 (mostrame los badges de estado de
   campaña y el tratamiento de tablas como extensión de ese sistema).
3. Para cada pantalla, **3–5 bullets** de qué cambiaste y por qué.

Priorizá **Login** (primera impresión), **Usuarios** y **Campañas** (son las que no tienen ningún
diseño todavía y las más densas). Podés mostrarme primero el tratamiento de **tabla + badges** (que
es nuevo en el sistema) y luego aplicarlo.
