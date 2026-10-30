// Guardrail de CI de supply-chain: que no entre (ni se quede) una vulnerabilidad alta o
// crítica en las dependencias de PRODUCCIÓN. Corre `npm audit` en la raíz y en `web/` y
// lee su JSON (no usa `--audit-level` de npm: el filtro por severidad y la allowlist son
// de este script, así un aviso aceptado temporalmente no rompe el CI y uno vencido sí).
//
// Dos modos:
//
//   node scripts/ci/checkAudit.mjs            (npm run ci:audit, BLOQUEANTE)
//     `npm audit --omit=dev --json` en raíz y web/. Sale con 1 si:
//       - hay un aviso alto/crítico de producción que no está en la allowlist vigente;
//       - un ítem de la allowlist venció (hoy >= `vence`), aparezca o no el aviso;
//       - la allowlist está mal formada, o `npm audit` no devolvió un reporte (sin red,
//         registry caído…): falla cerrado, se reintenta el job.
//     Las moderadas/bajas de producción se listan como aviso, sin fallar.
//
//   node scripts/ci/checkAudit.mjs --report   (npm run ci:audit:report, INFORMATIVO)
//     `npm audit --json` completo (incluye devDependencies) en raíz y web/. Lista cada
//     paquete con su severidad y si está evaluado en la allowlist (sección `desarrollo`,
//     con motivo y fecha de revisión). Nunca falla: es la foto para el repaso mensual.
//
// Allowlist: scripts/ci/auditAllowlist.json (formato documentado en el mismo archivo).
//   - `produccion`: avisos altos/críticos de producción aceptados TEMPORALMENTE, uno por
//     GHSA, con paquete, motivo y `vence` (AAAA-MM-DD). El día `vence` el CI falla: es la
//     fecha en que la versión parcheada cumple el mes de la política de dependencias
//     (CLAUDE.md) y hay que subirla.
//   - `desarrollo`: evaluación de los avisos de devDependencies (solo informativa), con
//     motivo y `revisar` (AAAA-MM-DD). Pasada la fecha, el reporte avisa; no falla.
//
// Sin dependencias: solo Node. Opciones para los tests (no se usan en CI):
//   --input <proyecto>=<archivo.json>   usa ese JSON de `npm audit` en vez de correrlo (repetible)
//   --allowlist <archivo.json>          otra allowlist
//   --today AAAA-MM-DD                  fecha "de hoy" (UTC por defecto)

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PROJECTS = [
  { label: "raíz", dir: ROOT },
  { label: "web", dir: path.join(ROOT, "web") },
];
const BLOCKING = new Set(["high", "critical"]);
const SEVERITY_ORDER = ["critical", "high", "moderate", "low", "info"];
const GHSA = /^GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const IN_CI = process.env.GITHUB_ACTIONS === "true";

// ── Argumentos ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const report = args.includes("--report");
const inputs = [];
let allowlistPath = path.join(ROOT, "scripts/ci/auditAllowlist.json");
let today = new Date().toISOString().slice(0, 10);
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--input") {
    const [label, file] = splitOnce(args[++i] ?? "", "=");
    if (!label || !file) usage("--input espera <proyecto>=<archivo.json>");
    inputs.push({ label, file });
  } else if (args[i] === "--allowlist") {
    allowlistPath = args[++i] ?? usage("--allowlist espera un archivo");
  } else if (args[i] === "--today") {
    today = args[++i] ?? "";
    if (!DATE.test(today)) usage("--today espera AAAA-MM-DD");
  } else if (args[i] !== "--report") {
    usage(`argumento desconocido: ${args[i]}`);
  }
}

const errors = []; // hacen fallar el modo bloqueante
const warnings = []; // nunca hacen fallar

// ── Allowlist ─────────────────────────────────────────────────────────────────
const allowlist = loadAllowlist(allowlistPath);

for (const entry of allowlist.produccion) {
  if (today >= entry.vence) {
    errors.push(
      `allowlist vencida: ${entry.aviso} (${entry.paquete}${entry.proyecto ? `, ${entry.proyecto}` : ""}) ` +
        `vencía el ${entry.vence}. Subí la versión parcheada (política de +1 mes, CLAUDE.md) o, si de verdad ` +
        `no se puede, renová la fecha con un motivo nuevo.`,
    );
  }
}
if (report) {
  for (const entry of allowlist.desarrollo) {
    if (today >= entry.revisar) {
      warnings.push(`evaluación de desarrollo para revisar desde el ${entry.revisar}: ${entry.paquetes.join(", ")} (${entry.proyecto}).`);
    }
  }
}

// ── Reportes de npm audit ─────────────────────────────────────────────────────
const sources = inputs.length > 0 ? inputs.map(fromFile) : PROJECTS.map(fromNpm);
const usedProd = new Set();
const usedDev = new Set();
const totals = [];

for (const { label, audit } of sources) {
  if (!audit) continue;
  const advisories = collectAdvisories(audit);
  totals.push(`${label}: ${formatCounts(audit.metadata?.vulnerabilities)}`);

  if (!report) {
    for (const adv of advisories) {
      const where = `[${label}] ${adv.paquete} — ${adv.id} (${adv.severity}): ${adv.title}`;
      if (!BLOCKING.has(adv.severity)) {
        warnings.push(`${where}. No bloquea (${adv.severity}); revisalo en el repaso mensual.`);
        continue;
      }
      const idx = allowlist.produccion.findIndex((e) => matchesProd(e, adv, label));
      if (idx === -1) {
        errors.push(`${where}. Afecta producción y no está en la allowlist. Arreglo: ${adv.fix}. Rango: ${adv.range}. ${adv.url}`);
      } else {
        usedProd.add(idx);
        const e = allowlist.produccion[idx];
        if (today < e.vence) console.log(`aceptado hasta el ${e.vence}: ${where} — ${e.motivo}`);
      }
    }
  } else {
    printReport(label, audit, advisories);
  }
}

if (inputs.length === 0 || sources.length === PROJECTS.length) {
  const unused = report
    ? allowlist.desarrollo.filter((_, i) => !usedDev.has(i)).map((e) => `desarrollo: ${e.paquetes.join(", ")} (${e.proyecto})`)
    : allowlist.produccion.filter((_, i) => !usedProd.has(i)).map((e) => `produccion: ${e.aviso} (${e.paquete})`);
  for (const u of unused) warnings.push(`ítem de la allowlist que ya no aparece en el audit (borralo): ${u}.`);
}

// ── Salida ────────────────────────────────────────────────────────────────────
if (totals.length > 0) console.log(`npm audit ${report ? "completo" : "--omit=dev"} → ${totals.join(" · ")}`);
for (const w of warnings) console.log(IN_CI ? `::warning::${w}` : `AVISO: ${w}`);

if (report) {
  for (const e of errors) console.log(IN_CI ? `::warning::${e}` : `AVISO: ${e}`);
  console.log("Reporte informativo: no falla. El bloqueante es `npm run ci:audit`.");
  process.exit(0);
}
if (errors.length > 0) {
  console.error(`Auditoría de dependencias de producción: ${errors.length} problema(s):`);
  for (const e of errors) console.error(IN_CI ? `::error::${e}` : `  - ${e}`);
  process.exit(1);
}
console.log("OK: sin vulnerabilidades altas/críticas de producción fuera de la allowlist (raíz y web).");

// ── Funciones ─────────────────────────────────────────────────────────────────

function usage(msg) {
  console.error(`checkAudit: ${msg}`);
  process.exit(2);
}

function splitOnce(s, sep) {
  const i = s.indexOf(sep);
  return i === -1 ? [s, ""] : [s.slice(0, i), s.slice(i + 1)];
}

function loadAllowlist(file) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    errors.push(`no se pudo leer la allowlist ${file}: ${err.message}`);
    return { produccion: [], desarrollo: [] };
  }
  const produccion = Array.isArray(raw.produccion) ? raw.produccion : [];
  const desarrollo = Array.isArray(raw.desarrollo) ? raw.desarrollo : [];
  if (!Array.isArray(raw.produccion) || !Array.isArray(raw.desarrollo)) {
    errors.push("allowlist mal formada: faltan los arreglos `produccion` y `desarrollo`.");
  }
  const bad = (where, why) => errors.push(`allowlist mal formada (${where}): ${why}`);
  const okProject = (p) => p === undefined || PROJECTS.some((x) => x.label === p);

  const valid = { produccion: [], desarrollo: [] };
  produccion.forEach((e, i) => {
    const where = `produccion[${i}]`;
    if (!e || typeof e !== "object") return bad(where, "no es un objeto");
    if (!GHSA.test(e.aviso ?? "")) return bad(where, "`aviso` debe ser un id GHSA (GHSA-xxxx-xxxx-xxxx)");
    if (!nonEmpty(e.paquete)) return bad(where, "falta `paquete`");
    if (!nonEmpty(e.motivo)) return bad(where, "falta `motivo`");
    if (!isDate(e.vence)) return bad(where, "`vence` debe ser una fecha AAAA-MM-DD");
    if (!okProject(e.proyecto)) return bad(where, "`proyecto` debe ser \"raíz\" o \"web\" (o no estar)");
    valid.produccion.push(e);
  });
  desarrollo.forEach((e, i) => {
    const where = `desarrollo[${i}]`;
    if (!e || typeof e !== "object") return bad(where, "no es un objeto");
    if (!Array.isArray(e.paquetes) || e.paquetes.length === 0 || !e.paquetes.every(nonEmpty)) {
      return bad(where, "`paquetes` debe ser una lista no vacía de nombres");
    }
    if (e.avisos !== undefined && (!Array.isArray(e.avisos) || !e.avisos.every((a) => GHSA.test(a)))) {
      return bad(where, "`avisos`, si está, debe ser una lista de ids GHSA");
    }
    if (!nonEmpty(e.proyecto) || !okProject(e.proyecto)) return bad(where, "`proyecto` debe ser \"raíz\" o \"web\"");
    if (!nonEmpty(e.motivo)) return bad(where, "falta `motivo`");
    if (!isDate(e.revisar)) return bad(where, "`revisar` debe ser una fecha AAAA-MM-DD");
    valid.desarrollo.push(e);
  });
  return valid;
}

function nonEmpty(s) {
  return typeof s === "string" && s.trim().length > 0;
}

function isDate(s) {
  return typeof s === "string" && DATE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
}

function fromFile({ label, file }) {
  try {
    return { label, audit: checkAuditShape(label, JSON.parse(readFileSync(file, "utf8"))) };
  } catch (err) {
    errors.push(`[${label}] no se pudo leer ${file}: ${err.message}`);
    return { label, audit: null };
  }
}

function fromNpm({ label, dir }) {
  if (!existsSync(path.join(dir, "package-lock.json"))) {
    errors.push(`[${label}] falta package-lock.json en ${dir}: npm audit necesita el lockfile.`);
    return { label, audit: null };
  }
  const npmArgs = ["audit", "--json", ...(report ? [] : ["--omit=dev"])];
  // Reintento único: un corte de red no debería tumbar el job a la primera.
  let lastProblem = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = runNpm(npmArgs, dir);
    try {
      const audit = JSON.parse(r.stdout);
      if (audit.error) throw new Error(audit.error.summary ?? audit.error.code ?? "error de npm audit");
      return { label, audit: checkAuditShape(label, audit) };
    } catch (err) {
      lastProblem = `${err.message}${r.stderr ? ` — ${r.stderr.trim().split("\n").slice(-3).join(" / ")}` : ""}`;
    }
  }
  errors.push(`[${label}] npm audit no devolvió un reporte válido (falla cerrado): ${lastProblem}`);
  return { label, audit: null };
}

function runNpm(npmArgs, cwd) {
  // Dentro de `npm run`, npm_execpath apunta al CLI de npm que se está usando.
  const cli = process.env.npm_execpath;
  const opts = { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 };
  if (cli && cli.endsWith(".js")) return spawnSync(process.execPath, [cli, ...npmArgs], opts);
  return spawnSync("npm", npmArgs, { ...opts, shell: process.platform === "win32" });
}

function checkAuditShape(label, audit) {
  if (audit?.error) {
    errors.push(`[${label}] el reporte de npm audit trae un error: ${audit.error.summary ?? audit.error.code ?? "desconocido"}`);
    return null;
  }
  if (!audit || typeof audit.vulnerabilities !== "object" || audit.vulnerabilities === null) {
    errors.push(`[${label}] el JSON no parece un reporte de \`npm audit --json\` (falta \`vulnerabilities\`).`);
    return null;
  }
  return audit;
}

/** Un aviso por (paquete, GHSA): los `via` que son objetos son los avisos propios del paquete. */
function collectAdvisories(audit) {
  const out = new Map();
  for (const vuln of Object.values(audit.vulnerabilities)) {
    for (const via of vuln.via ?? []) {
      if (!via || typeof via !== "object") continue;
      const id = /GHSA-[\w-]+/.exec(via.url ?? "")?.[0] ?? `npm-${via.source}`;
      const paquete = via.name ?? vuln.name;
      const key = `${paquete}|${id}`;
      if (out.has(key)) continue;
      out.set(key, {
        id,
        paquete,
        severity: via.severity ?? vuln.severity,
        title: via.title ?? "",
        url: via.url ?? "",
        range: via.range ?? vuln.range ?? "",
        fix: describeFix(audit.vulnerabilities[paquete]?.fixAvailable ?? vuln.fixAvailable),
      });
    }
  }
  return [...out.values()];
}

function describeFix(fix) {
  if (fix === true) return "hay versión parcheada dentro del rango (no uses `npm audit fix` a ciegas: toma la última, respetá el +1 mes)";
  if (fix && typeof fix === "object") return `${fix.name}@${fix.version}${fix.isSemVerMajor ? " (cambio mayor)" : ""}`;
  return "sin versión parcheada publicada";
}

function matchesProd(entry, adv, label) {
  return (
    today < entry.vence &&
    entry.aviso.toLowerCase() === adv.id.toLowerCase() &&
    entry.paquete === adv.paquete &&
    (entry.proyecto === undefined || entry.proyecto === label)
  );
}

function formatCounts(v) {
  if (!v) return "sin conteo";
  const parts = SEVERITY_ORDER.filter((s) => v[s] > 0).map((s) => `${v[s]} ${s}`);
  return parts.length > 0 ? `${v.total} (${parts.join(", ")})` : "0";
}

function printReport(label, audit, advisories) {
  const vulns = Object.values(audit.vulnerabilities).sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) || a.name.localeCompare(b.name),
  );
  console.log(`\n── ${label}: ${formatCounts(audit.metadata?.vulnerabilities)} ──`);
  const notes = new Set();
  for (const v of vulns) {
    const own = advisories.filter((a) => a.paquete === v.name);
    const ids = own.map((a) => a.id);
    const via = own.length === 0 ? ` (vía ${(v.via ?? []).filter((x) => typeof x === "string").join(", ")})` : "";
    const devIdx = allowlist.desarrollo.findIndex(
      (e) => e.proyecto === label && e.paquetes.includes(v.name) && (!e.avisos || ids.every((id) => e.avisos.includes(id))),
    );
    const prod = own.some((a) => allowlist.produccion.some((e) => matchesProd(e, a, label)));
    let estado;
    if (devIdx !== -1) {
      usedDev.add(devIdx);
      notes.add(devIdx);
      estado = `evaluado [nota ${devIdx + 1}, revisar ${allowlist.desarrollo[devIdx].revisar}]`;
    } else if (prod) {
      estado = "aceptado temporalmente en producción (ver allowlist)";
    } else {
      estado = "SIN EVALUAR";
      warnings.push(`[${label}] ${v.name} (${v.severity}) no está evaluado en la allowlist: agregalo a \`desarrollo\` con motivo, o arreglalo.`);
    }
    console.log(`  ${v.severity.padEnd(8)} ${v.name}${via}${ids.length ? ` [${ids.join(", ")}]` : ""}`);
    console.log(`           arreglo: ${describeFix(v.fixAvailable)} · ${estado}`);
  }
  for (const i of [...notes].sort((a, b) => a - b)) console.log(`  [nota ${i + 1}] ${allowlist.desarrollo[i].motivo}`);
}
