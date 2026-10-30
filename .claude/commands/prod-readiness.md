---
description: Orquesta la serie de prompts de preparación para producción (docs/prompts-produccion) sobre el último PR abierto
---

Sos el orquestador de la serie `docs/prompts-produccion/`. Leé primero `docs/prompts-produccion/00-INDICE.md` completo
(sobre todo "Base: siempre el último PR abierto") y `docs/prompts-produccion/PROGRESO.md`.

Si te pasaron un slug como argumento, empezá por ese: $ARGUMENTS
Si no, seguí con el primer slug de la tabla del índice que no esté "hecho" ni "saltado" en `PROGRESO.md`.

Ejecutá los prompts DE A UNO, en el orden de la tabla del índice, con este ciclo para cada slug:

0. **Base.** Buscá el último PR abierto y sincronizá `prod/readiness` con su cabeza, exactamente como dice el índice
   (merge, nunca rebase ni force-push; si hay conflictos o el PR nuevo no contiene al anterior, pará y avisame).
   Decime en una línea qué PR, rama y sha quedó de base, y anotalo en `PROGRESO.md`.
1. Leé `docs/prompts-produccion/<slug>.md` completo.
2. Verificá que en `prod/readiness` esté mergeado el trabajo de su "Depende de" (según `PROGRESO.md` y el git log).
   Si falta, pará y avisame.
3. Haceme JUNTAS todas las preguntas de su sección "Decisiones que el agente NO toma solo" antes de lanzarlo
   (el subagente no puede preguntarme). Si decido "todavía no", saltalo y anotalo.
4. Lanzá UN subagente (general-purpose) con el contenido íntegro del archivo + una sección final
   "Decisiones del usuario" con mis respuestas textuales y la base actual (PR #, rama, sha). Nunca dos a la vez.
5. Cuando termine: revisá su reporte y el diff de `prod/<slug>` contra `prod/readiness`, corré `npm run typecheck` y
   `npm test` (y en `web/` si tocó el panel). Mostrame un resumen corto: qué cambió, cómo se verificó, qué quedó para mí.
6. Preguntame si mergeo `prod/<slug>` a `prod/readiness`. Solo con mi sí. Sin push salvo que lo pida.
7. Seguí con el siguiente (volviendo al paso 0: si mientras tanto se abrió un PR nuevo o el último recibió commits,
   se mergea antes de lanzar el próximo prompt).

Llevá `docs/prompts-produccion/PROGRESO.md` al día (una fila por slug).
Si un agente falla o deja tests en rojo, pará y consultame.
