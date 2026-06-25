# CLAUDE.md

Agente de WhatsApp con IA (soporte + agenda de citas) para lavacar, multi-tenant y pensado como producto SaaS white-label. Backend en TypeScript (Node `node:http`, sin framework), OpenAI, Drizzle + Postgres (Supabase), Google Calendar. Panel web (bandeja humana + CRM + dashboard, PWA con push) servido en `/panel`. Deploy: ver `DEPLOY.md`.

## ROADMAP.md — manténgalo vivo (IMPORTANTE)

`ROADMAP.md` es la **fuente de verdad** del plan de arquitectura/evolución a SaaS.

- **Siempre que completes o avances materialmente un ítem del ROADMAP, actualiza su casilla/estado en el MISMO cambio (commit) que hace el trabajo.** No es un paso aparte: es parte de terminar la tarea.
- Si haces trabajo nuevo que no encaja en ningún ítem, **agrégalo** al ROADMAP en la sección que corresponda.
- Al editar el ROADMAP, actualiza la fecha de "Última actualización".
- Antes de proponer trabajo de arquitectura, lee el ROADMAP para no duplicar ni contradecir el plan acordado.

## Convenciones del repo

- Código y comentarios en español (es-CR), igual que el código existente.
- El panel y el backend se comunican por la API JSON `/api/panel/*` — esa costura es estable; respétala al migrar el panel a React.
- Secretos en `.env` (gitignored); ver `.env.example` para la lista vigente.
