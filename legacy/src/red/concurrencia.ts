// ─────────────────────────────────────────────────────────────────────────────
// Concurrencia acotada para loops que recorren tenants (F12, PLAN-ESCALA-MULTITENANT).
//
// POR QUÉ: recorrer los tenants en serie (uno tras otro, con varias queries y
// envíos cada uno) escala mal — a 50 negocios un solo tick puede tardar más que
// el intervalo configurado. Pero lanzarlos TODOS en paralelo tampoco sirve:
// satura de golpe el pool de conexiones a la base y las APIs externas
// (WhatsApp, OpenAI, Google). La solución es un límite de concurrencia: como
// máximo N tenants en vuelo a la vez. Se escribe a mano (sin p-limit/p-map ni
// dependencias similares) porque son ~15 líneas y la política de dependencias
// del repo exige justificar cualquier paquete nuevo.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Aplica `fn` a cada elemento de `items`, con a lo sumo `limite` ejecuciones
 * concurrentes. El array de resultados preserva el orden de `items` (como
 * `Promise.all`), sin importar en qué orden terminen de ejecutarse.
 *
 * Semántica de errores: si `fn` rechaza para algún ítem, ese rechazo NO corta
 * el lote — el resto de los ítems se sigue procesando con normalidad (a
 * diferencia de `Promise.all`, que aborta apenas el primero falla). Al
 * terminar todos, si hubo al menos un error, se relanza un único
 * `AggregateError` con todos ellos para que el llamador decida qué hacer
 * (loguear, reportar a Sentry, etc.) — a diferencia de `Promise.allSettled`,
 * que nunca rechaza y obliga a inspeccionar cada resultado a mano.
 *
 * En los llamadores actuales (recordatorios, reputación) cada tenant ya se
 * procesa dentro de su propio try/catch antes de llegar acá, así que `fn`
 * nunca rechaza en la práctica — pero el helper no puede asumir eso.
 */
export async function mapConLimite<T, R>(
  items: readonly T[],
  limite: number,
  fn: (item: T, indice: number) => Promise<R>,
): Promise<R[]> {
  const resultados: R[] = new Array(items.length);
  const errores: unknown[] = [];
  let siguiente = 0;

  async function trabajador(): Promise<void> {
    for (let i = siguiente++; i < items.length; i = siguiente++) {
      try {
        resultados[i] = await fn(items[i], i);
      } catch (e) {
        errores.push(e);
      }
    }
  }

  const cantidadTrabajadores = Math.max(1, Math.min(limite, items.length || 1));
  await Promise.all(Array.from({ length: cantidadTrabajadores }, trabajador));

  if (errores.length > 0) {
    throw new AggregateError(errores, `mapConLimite: ${errores.length} de ${items.length} ítem(s) fallaron`);
  }
  return resultados;
}
