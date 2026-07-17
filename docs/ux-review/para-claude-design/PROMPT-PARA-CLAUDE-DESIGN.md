# Prompt para Claude Design

> Pegá todo lo que sigue en Claude Design y adjuntá las **10 capturas** de esta carpeta
> (`docs/ux-review/para-claude-design/`). Son una selección; el set completo está en
> `docs/ux-review/`. Qué es cada una:
>
> 1. `02-inbox-lista-desktop-claro.png` — Bandeja (desktop, claro) · pantalla prioritaria
> 2. `11-inbox-lista-desktop-oscuro.png` — Bandeja (desktop, oscuro)
> 3. `15-inbox-lista-movil-claro.png` — Bandeja (móvil, bottom nav)
> 4. `05-dashboard-desktop-claro.png` — Panel/KPIs (desktop, claro) · pantalla prioritaria
> 5. `13-dashboard-desktop-oscuro.png` — Panel/KPIs (desktop, oscuro)
> 6. `03-chat-conversacion-desktop-claro.png` — Conversación + acciones rápidas
> 7. `04-ficha-cliente-desktop-claro.png` — Modal Ficha del cliente
> 8. `08-mi-negocio-desktop-claro.png` — Config: editor de servicios (apretado)
> 9. `21-mi-negocio-movil-claro.png` — Config en móvil (apretado)
> 10. `06-agenda-desktop-claro.png` — Agenda (estado vacío / poca densidad)

---

Sos un diseñador de producto senior. Necesito que **rediseñes la UX/UI del panel web** de un
producto SaaS y me devuelvas propuestas visuales concretas (mockups) pantalla por pantalla, más
un sistema de diseño coherente que las una. Te adjunto capturas del estado actual (desktop y móvil,
tema claro y oscuro).

## Qué es el producto

Es el **panel de administración de un agente de WhatsApp con IA** para lavacars (lavado de autos),
vendido como SaaS **white-label multi-tenant** (cada negocio lo ve con su marca). El agente atiende
clientes por WhatsApp: responde consultas, cotiza y **agenda citas** solo. El panel es donde el
negocio supervisa todo eso.

Hay **dos tipos de usuario**:
- **Operador** — vive en la *Bandeja/Inbox*: ve las conversaciones que lleva el bot, puede tomar el
  control ("atender yo"), responder a mano y devolver la charla al bot.
- **Dueño** — además ve *Panel* (métricas), *Agenda* (citas), *Mi negocio* (config), *Usuarios* y
  *Campañas*.

El usuario final es **dueño de un lavacar en Costa Rica**, no técnico. La herramienta se usa mucho
**desde el celular** entre autos. El tono debe ser claro, confiable y comercial (les vendemos que
"el bot les ahorra plata y les agenda solo").

## Dirección de estilo: PREMIUM (importante)

Quiero que el panel se sienta **caro, pulido y de producto serio**, no un CRUD genérico ni una
plantilla de admin. Referencia mental: la calidad de Linear, Stripe Dashboard, Vercel, Superhuman
— herramientas que transmiten confianza y oficio. En concreto:

- **Refinamiento sobre decoración:** jerarquía tipográfica fuerte y deliberada, mucho aire/espacio
  en blanco bien administrado, alineación impecable a una grilla. Nada apretado ni "lleno".
- **Neutrales sofisticados** (no grises puros de sistema): superficies con tono cálido/frío sutil,
  bordes finos de bajo contraste, y **sombras suaves y en capas** en vez de bordes duros para
  separar tarjetas. El acento del negocio se usa **con moderación** (CTAs, estado activo, un dato
  clave), no en bloques grandes de color.
- **Detalle fino:** radios de esquina consistentes, iconografía de trazo uniforme, números
  **tabulares** para métricas y dinero, microinteracciones/transiciones sutiles (hover, foco,
  cambios de estado), estados de foco accesibles y elegantes.
- **Datos que se leen como producto premium:** los KPIs y el dinero deben verse como un dashboard
  financiero cuidado (jerarquía clara, unidades discretas, deltas con color semántico sobrio), no
  como tarjetas planas repetidas.
- Que se sienta premium **igual en móvil** (es donde más se usa) y **en ambos temas** — el modo
  oscuro debe verse intencional y rico, no un claro invertido.

Evitá: gradientes chillones, sombras exageradas, demasiados colores, esquinas súper redondeadas
tipo "app de juguete", o llenar todo con el color de marca. Premium = contención y precisión.

## Restricciones que NO se pueden romper (importante)

1. **White-label:** el color de acento y el del encabezado son **configurables por negocio** (hoy
   verde para este cliente). El diseño no puede depender de un color fijo: definí el sistema con
   **tokens** (un acento + neutrales) para que cambiar el acento repinte todo con coherencia.
2. **Tema claro y oscuro**, ambos deben quedar bien (te paso capturas de los dos).
3. **Mobile-first / responsive:** en móvil la navegación es una **barra inferior (bottom nav)**; en
   desktop son **tabs segmentadas** en el header. Mantené ese patrón o proponé algo mejor pero que
   funcione igual de bien en las dos anchuras (390px y 1440px).
4. Es una **PWA** (se instala en el teléfono), así que pensá en densidad táctil y áreas de toque.
5. Copy en **español de Costa Rica** (voseo: "agendá", "escribí", "cotización").
6. Es solo **rediseño visual/UX**: la estructura de datos y las acciones ya existen, no inventes
   features nuevas de backend. Podés reorganizar, jerarquizar, agrupar y mejorar microcopy.

## Problemas que ya detecté (mejorá estos y los que veas)

- **Bandeja/Inbox:** cada conversación arranca con un **número suelto (90, 75, 65, 50…)** que es un
  "lead score" pero no tiene etiqueta ni leyenda → se ve críptico. Los tags BOT/HUMANO, la hora, el
  contador sin-leer y el score compiten por atención. Falta jerarquía y falta señal de "esta
  necesita que yo intervenga".
- **Dashboard/Panel:** son **12 tarjetas KPI idénticas y planas**, todas con el mismo peso visual →
  no se sabe qué mirar primero. Métricas de plata, de conversión y de riesgo (no-show) mezcladas sin
  agrupar. El gráfico de "citas por día" queda apretado abajo. Quiero jerarquía, agrupación y que
  los números de dinero destaquen.
- **Chat/Conversación:** el encabezado apila estado ("lo atiende el bot", "cierra en 23h", pills) y
  las acciones rápidas (Agendar cita / Cotización / Atendido) sin mucha jerarquía. Las burbujas
  funcionan pero se pueden pulir.
- **Mi negocio (config):** el **editor de servicios está muy apretado** — inputs truncados
  ("lavado_pulido_se"), checkboxes desalineados ("precio variable", "agendable", "ofrecer add-on"),
  todo amontonado. Necesita respirar, agruparse por servicio en tarjetas claras y ser usable en
  móvil.
- **Agenda:** mucho **espacio vacío** y poca densidad de información; el estado "sin citas" se ve
  pobre. Proponé una vista de día/semana más rica y útil.
- **Estados vacíos y de error** (ej. "Elegí una conversación", "No se pudieron cargar las campañas")
  se pueden hacer más cálidos y con mejor guía.
- **Ficha del cliente (modal):** está decente; mejorá la jerarquía entre datos, historial de
  servicios y notas privadas.

## Qué quiero de vos

1. Un **sistema de diseño** breve pero con acabado premium: paleta con tokens (acento configurable +
   neutrales sofisticados para claro y oscuro), tipografía con jerarquía marcada, escala de
   espaciado, elevación (sombras en capas), estilo de tarjetas/botones/inputs/pills, y cómo tratar
   los estados (activo, bot, humano, éxito, riesgo).
2. **Mockups rediseñados** de estas pantallas, en desktop y móvil: Login, Bandeja/Inbox (lista +
   chat), Chat con acciones, Ficha del cliente, Dashboard, Agenda, Mi negocio (editor de servicios),
   y los estados vacío/error.
3. Para cada pantalla, **3–5 bullets** explicando qué cambiaste y por qué (jerarquía, agrupación,
   affordances).
4. Mantené una **identidad coherente** entre todas las pantallas.

Priorizá **Bandeja/Inbox** y **Dashboard/Panel** (son las que más se usan y las que peor están hoy).
Podés empezar mostrándome 1–2 direcciones de estilo antes de aplicar a todo.
