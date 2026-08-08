import "dotenv/config";
import { and, eq, like, notInArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { waConversaciones, waMensajes } from "../src/db/schema";
import { storageConfigurado, subirImagen } from "../src/storage/supabaseStorage";

// ─────────────────────────────────────────────────────────────────────────────
// Migración Carril F, F9: sube a Supabase Storage el binario de cada foto que
// hoy vive como data URL base64 COMPLETA en `wa_mensajes.media_url` (filas de
// antes de F9, o guardadas mientras Storage no estaba configurado) y reemplaza
// la columna por la RUTA CORTA del objeto — mismo esquema de path que usa el
// código en caliente (`storage/supabaseStorage.ts`: tenantId/conversacionId/waMessageId.ext).
//
// IDEMPOTENTE — se puede correr las veces que haga falta: el criterio para tocar
// una fila es "media_url empieza con 'data:'"; una vez migrada, la siguiente
// corrida ya no la selecciona. Corre en LOTES (no un UPDATE masivo de una sola
// pasada) para no tensar la base ni el proceso con conversaciones grandes.
//
// Si una fila puntual falla (data URL corrupto, Storage caído a mitad de
// corrida), se loguea y se EXCLUYE del resto de esta corrida — no bloquea a las
// demás ni entra en loop infinito reintentándola en cada lote. Corré el script
// de nuevo más tarde para reintentar las que quedaron pendientes.
//
//   Ejecutar:  npx tsx scripts/migrarFotosAStorage.ts
//
// Nunca imprime el contenido de una foto (ni el data URL ni la ruta firmada) —
// solo ids de fila/tenant y conteos.
// ─────────────────────────────────────────────────────────────────────────────

const LOTE = Number(process.env.MIGRAR_FOTOS_LOTE) || 25;

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("❌ Falta DATABASE_URL en el .env");
  process.exit(1);
}
if (!storageConfigurado()) {
  console.error("❌ Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY: no hay a dónde subir las fotos.");
  console.error("   Configuralas primero (ver .env.example, sección Supabase Storage) y volvé a correr.");
  process.exit(1);
}

const esSupabase = /supabase\.(co|com)/.test(url);
const sql = esSupabase ? postgres(url, { ssl: "require", prepare: false, max: 1 }) : postgres(url, { max: 1 });

/** Descompone un data URL ("data:image/jpeg;base64,AAAA…") en mimeType + bytes. */
function decodificarDataUrl(dataUrl: string): { buffer: Buffer; mimeType: string } | null {
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl);
  if (!m) return null;
  try {
    return { mimeType: m[1], buffer: Buffer.from(m[2], "base64") };
  } catch {
    return null;
  }
}

try {
  const db = drizzle(sql);
  console.log(`Migrando fotos data: URL → Supabase Storage (lotes de ${LOTE})…`);

  let migradas = 0;
  let sinDecodificar = 0;
  let errores = 0;
  // Filas que fallaron en esta corrida: se excluyen del resto de las pasadas para
  // no reprocesarlas en loop (siguen empezando con "data:" hasta que se arreglen).
  const idsAOmitir: string[] = [];

  for (;;) {
    const condiciones = [like(waMensajes.mediaUrl, "data:%")];
    if (idsAOmitir.length) condiciones.push(notInArray(waMensajes.id, idsAOmitir));

    const filas = await db
      .select({
        id: waMensajes.id,
        conversacionId: waMensajes.conversacionId,
        waMessageId: waMensajes.waMessageId,
        mediaUrl: waMensajes.mediaUrl,
        tenantId: waConversaciones.tenantId,
      })
      .from(waMensajes)
      .innerJoin(waConversaciones, eq(waMensajes.conversacionId, waConversaciones.id))
      .where(and(...condiciones))
      .limit(LOTE);

    if (filas.length === 0) break;

    for (const fila of filas) {
      const decodificado = fila.mediaUrl ? decodificarDataUrl(fila.mediaUrl) : null;
      if (!decodificado) {
        console.error(`⚠️  fila ${fila.id} (tenant ${fila.tenantId}): data URL no decodificable, se deja intacta`);
        sinDecodificar++;
        idsAOmitir.push(fila.id);
        continue;
      }
      // waMessageId es NULL en salientes, pero los salientes nunca tienen media —
      // esta rama solo ve entrantes, que siempre lo traen. Fallback defensivo igual.
      const idParaRuta = fila.waMessageId ?? fila.id;
      try {
        const ruta = await subirImagen(
          fila.tenantId,
          fila.conversacionId,
          idParaRuta,
          decodificado.buffer,
          decodificado.mimeType,
        );
        await db.update(waMensajes).set({ mediaUrl: ruta }).where(eq(waMensajes.id, fila.id));
        migradas++;
      } catch (e) {
        console.error(`❌ fila ${fila.id} (tenant ${fila.tenantId}): no se pudo migrar:`, e instanceof Error ? e.message : e);
        errores++;
        idsAOmitir.push(fila.id);
      }
    }
    console.log(`  … lote procesado (${migradas} migradas, ${errores} con error, ${sinDecodificar} no decodificables hasta ahora)`);
  }

  console.log(
    `✅ Listo. Migradas: ${migradas} · sin decodificar: ${sinDecodificar} · con error de subida: ${errores}.`,
  );
  if (sinDecodificar + errores > 0) {
    console.log("   Las filas con error quedaron con su data URL intacto (no se pierde nada); corré el script de nuevo para reintentarlas.");
  }
} catch (e) {
  console.error("❌ Error:", e instanceof Error ? e.message : e);
  if (e instanceof Error && e.cause instanceof Error) {
    console.error("   causa:", e.cause.message);
  }
  process.exitCode = 1;
} finally {
  await sql.end();
}
