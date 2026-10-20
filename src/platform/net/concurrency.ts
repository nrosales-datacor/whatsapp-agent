// ─────────────────────────────────────────────────────────────────────────────
// Concurrencia acotada para loops que recorren negocios.
//
// POR QUÉ: recorrer los negocios en serie (uno tras otro, con varias queries y envíos
// cada uno) escala mal — a 50 negocios un solo tick puede tardar más que el intervalo
// configurado. Pero lanzarlos TODOS en paralelo tampoco sirve: satura de golpe el pool
// de conexiones a la base y las APIs externas. La solución es un límite de concurrencia:
// como máximo N en vuelo a la vez. Se escribe a mano (sin p-limit/p-map) porque son ~15
// líneas y la política de dependencias del repo exige justificar cualquier paquete nuevo.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Aplica `fn` a cada elemento de `items`, con a lo sumo `limit` ejecuciones concurrentes.
 * El array de resultados preserva el orden de `items` (como `Promise.all`), sin importar
 * en qué orden terminen.
 *
 * Semántica de errores: si `fn` rechaza para algún ítem, ese rechazo NO corta el lote —
 * el resto se sigue procesando (a diferencia de `Promise.all`, que aborta con el primer
 * fallo). Al terminar todos, si hubo al menos un error, se relanza un único
 * `AggregateError` con todos ellos para que el llamador decida qué hacer (loguear,
 * reportar a Sentry…) — a diferencia de `Promise.allSettled`, que nunca rechaza y obliga
 * a inspeccionar cada resultado a mano.
 */
export async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  const errors: unknown[] = [];
  let next = 0;

  async function worker(): Promise<void> {
    for (let i = next++; i < items.length; i = next++) {
      try {
        results[i] = await fn(items[i], i);
      } catch (e) {
        errors.push(e);
      }
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length || 1));
  await Promise.all(Array.from({ length: workerCount }, worker));

  if (errors.length > 0) {
    throw new AggregateError(errors, `mapWithLimit: ${errors.length} de ${items.length} ítem(s) fallaron`);
  }
  return results;
}
