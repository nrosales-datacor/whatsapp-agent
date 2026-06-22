// Limpia los datos de DEMO que el seed pudo haber insertado en la base.
// Por defecto SOLO reporta (assessment). Con --delete borra, pero de forma
// SEGURA: únicamente filas creadas en la última hora (las del seed), sin tocar
// nada anterior. Uso:
//   node scripts/cleanupDemo.mjs            (reporta)
//   node scripts/cleanupDemo.mjs --delete   (borra lo reciente)
import "dotenv/config";
import postgres from "postgres";

const TENANT = "lavacar-rosales";
const NUMS = [
  "50687123344", "50670112233", "50671778899", "50689998877", "50688456677",
  "50689112266", "50683221100", "50662445566", "50685334411", "50688221144",
  "50661778822", "50683009988", "50687220033", "50684556677", "50687665544",
  "50661334477", "50688777001", "50687001122", "50689443322",
];
const DELETE = process.argv.includes("--delete");

const url = process.env.DATABASE_URL;
if (!url) { console.error("No hay DATABASE_URL"); process.exit(1); }
const esSupabase = /supabase\.(co|com)/.test(url);
const sql = esSupabase ? postgres(url, { ssl: "require", prepare: false }) : postgres(url);

try {
  const convs = await sql`
    SELECT c.cliente_wa, c.creada_en, c.modo,
           (now() - c.creada_en < interval '1 hour') AS reciente,
           (SELECT count(*) FROM wa_mensajes m WHERE m.conversacion_id = c.id) AS msgs,
           (SELECT count(*) FROM wa_mensajes m WHERE m.conversacion_id = c.id
              AND now() - m.creado_en < interval '1 hour') AS msgs_recientes
    FROM wa_conversaciones c
    WHERE c.tenant_id = ${TENANT} AND c.cliente_wa IN ${sql(NUMS)}
    ORDER BY c.creada_en DESC`;
  console.log("=== Conversaciones que matchean números demo ===");
  for (const r of convs) {
    console.log(`  ${r.cliente_wa} | creada=${new Date(r.creada_en).toISOString()} | reciente=${r.reciente} | modo=${r.modo} | msgs=${r.msgs} (recientes=${r.msgs_recientes})`);
  }
  const preexist = convs.filter((r) => !r.reciente);
  console.log(`Total conv match: ${convs.length} | PRE-EXISTENTES (>1h, NO se tocan): ${preexist.length}`);

  const citas = await sql`
    SELECT cliente_wa, fecha, hora, precio, creada_en,
           (now() - creada_en < interval '1 hour') AS reciente
    FROM wa_citas WHERE tenant_id = ${TENANT} AND cliente_wa IN ${sql(NUMS)}
    ORDER BY creada_en DESC`;
  console.log(`\n=== Citas que matchean números demo: ${citas.length} (recientes: ${citas.filter((c) => c.reciente).length}) ===`);

  if (!DELETE) {
    console.log("\n[assessment] nada borrado. Pasá --delete para borrar SOLO lo reciente.");
  } else {
    const delMsgs = await sql`
      DELETE FROM wa_mensajes
      WHERE now() - creado_en < interval '1 hour'
        AND conversacion_id IN (
          SELECT id FROM wa_conversaciones
          WHERE tenant_id = ${TENANT} AND cliente_wa IN ${sql(NUMS)})`;
    const delCitas = await sql`
      DELETE FROM wa_citas
      WHERE now() - creada_en < interval '1 hour'
        AND tenant_id = ${TENANT} AND cliente_wa IN ${sql(NUMS)}`;
    const delConvs = await sql`
      DELETE FROM wa_conversaciones c
      WHERE now() - c.creada_en < interval '1 hour'
        AND c.tenant_id = ${TENANT} AND c.cliente_wa IN ${sql(NUMS)}
        AND NOT EXISTS (SELECT 1 FROM wa_mensajes m WHERE m.conversacion_id = c.id)`;
    console.log(`\n[delete] mensajes=${delMsgs.count} · citas=${delCitas.count} · conversaciones=${delConvs.count}`);
  }
} finally {
  await sql.end({ timeout: 5 });
}
