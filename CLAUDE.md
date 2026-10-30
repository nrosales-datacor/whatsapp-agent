# CLAUDE.md

Agente de WhatsApp con IA (soporte + agenda de citas) para lavacar, multi-tenant y pensado como producto SaaS white-label. Backend en TypeScript (Node `node:http`, sin framework), OpenAI, Drizzle + Postgres (Supabase), Google Calendar. Panel web (bandeja humana + CRM + dashboard, PWA con push) servido en `/panel`. Deploy: ver `DEPLOY.md`.

> **Reestructura en curso (Carril I, rama `carril-i`):** el producto pasa a ser **Selyon CRM** (nombre provisional),
> software de gestión para negocios con cita (dental, estética, uñas), multi-sucursal, con WhatsApp IA como módulo; el
> lavacar se elimina. El plan acordado (arquitectura,
> modelo de datos, fases) está en `PLAN-GESTION.md`: léelo antes de tocar el esquema o la estructura de carpetas.

## Flujo de trabajo: pull requests (OBLIGATORIO)

- Todo cambio vive en su rama y se revisa en un **PR que el usuario aprueba antes de mergear**. Nunca se mergea a la
  rama base (ni a `main`) por cuenta propia.
- Subir ramas y abrir PRs solo cuando el usuario lo pida.
- Reestructura (Carril I): **ramas apiladas por sección** (`i0/platform` sobre `carril-i`, la siguiente sobre esa…);
  el PR de cada sección apunta a la rama anterior. Commits chicos y con sentido dentro de cada rama.

## ROADMAP.md — manténgalo vivo (IMPORTANTE)

`ROADMAP.md` es la **fuente de verdad** del plan de arquitectura/evolución a SaaS.

- **Siempre que completes o avances materialmente un ítem del ROADMAP, actualiza su casilla/estado en el MISMO cambio (commit) que hace el trabajo.** No es un paso aparte: es parte de terminar la tarea.
- Si haces trabajo nuevo que no encaja en ningún ítem, **agrégalo** al ROADMAP en la sección que corresponda.
- Al editar el ROADMAP, actualiza la fecha de "Última actualización".
- Antes de proponer trabajo de arquitectura, lee el ROADMAP para no duplicar ni contradecir el plan acordado.

## Preparación para producción

`docs/prompts-produccion/` es una serie de prompts (uno por punto del checklist de producción). Se arranca con `/prod-readiness`: el orquestador trabaja siempre sobre la cabeza del **último PR abierto** (ver `00-INDICE.md`) y lleva el estado en `PROGRESO.md`. Cada prompt corre en su rama `prod/<slug>` y se mergea a `prod/readiness` solo con aprobación del usuario.

## Convenciones del repo

- **Identificadores en inglés** (decisión del 2026-10-19): clases, funciones, variables, tipos, archivos, carpetas,
  tablas, columnas, valores de enums, rutas de la API y nombres de las tools del agente. **Comentarios, documentación,
  commits y textos de la UI en español (es-CR).** El código existente en español se traduce al portarlo en el Carril I;
  no se mezclan idiomas en los identificadores de un mismo archivo nuevo.
- El panel y el backend se comunican por la API JSON `/api/panel/*` — esa costura es estable; respétala al migrar el panel a React.
- Secretos en `.env` (gitignored); ver `.env.example` para la lista vigente.

## Política de dependencias (supply-chain — OBLIGATORIO)

Antes de instalar **cualquier** paquete (`npm install`), se cumplen las TRES reglas. Si una falla, no se instala: se busca alternativa o se hace a mano.

1. **Ampliamente usado.** Paquete establecido y popular (no nicho, no recién nacido).
2. **Publisher conocido.** Autor/organización reputada y reconocible.
3. **Versión con +1 mes de publicada.** Nunca se instala una versión recién salida (ventana para detectar paquetes comprometidos). Verificar con `npm view <pkg> time --json` y **fijar la versión exacta** (sin `^`/`~`) a una que tenga más de un mes.
