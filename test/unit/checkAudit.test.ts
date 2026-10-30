import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// ─────────────────────────────────────────────────────────────────────────────
// Guardrail de CI de la auditoría de dependencias (scripts/ci/checkAudit.mjs, `npm run
// ci:audit` en el job verify). Se corre el script real con reportes de `npm audit --json`
// armados acá (--input) y una allowlist temporal: sin red ni npm.
// ─────────────────────────────────────────────────────────────────────────────

const SCRIPT = path.resolve("scripts/ci/checkAudit.mjs");
const dir = mkdtempSync(path.join(tmpdir(), "check-audit-"));
after(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
function writeJson(value: unknown): string {
  const file = path.join(dir, `f${n++}.json`);
  writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  return file;
}

type Advisory = { pkg: string; id: string; severity: string; title?: string };

/** Reporte con la forma de `npm audit --json` (v2): un aviso propio por paquete. */
function audit(advisories: Advisory[], extra: Record<string, unknown> = {}) {
  const vulnerabilities: Record<string, unknown> = {};
  for (const a of advisories) {
    vulnerabilities[a.pkg] = {
      name: a.pkg,
      severity: a.severity,
      isDirect: true,
      via: [
        {
          source: 1,
          name: a.pkg,
          dependency: a.pkg,
          title: a.title ?? `falla de ${a.pkg}`,
          url: `https://github.com/advisories/${a.id}`,
          severity: a.severity,
          range: "<9.9.9",
        },
      ],
      effects: [],
      range: "<9.9.9",
      nodes: [`node_modules/${a.pkg}`],
      fixAvailable: { name: a.pkg, version: "9.9.9", isSemVerMajor: false },
    };
  }
  const count = (s: string) => advisories.filter((a) => a.severity === s).length;
  return {
    auditReportVersion: 2,
    vulnerabilities: { ...vulnerabilities, ...extra },
    metadata: {
      vulnerabilities: {
        info: 0,
        low: count("low"),
        moderate: count("moderate"),
        high: count("high"),
        critical: count("critical"),
        total: Object.keys(vulnerabilities).length + Object.keys(extra).length,
      },
    },
  };
}

function run(opts: {
  raiz?: unknown;
  web?: unknown;
  allowlist?: unknown;
  today?: string;
  report?: boolean;
}) {
  const args = [SCRIPT];
  if (opts.report) args.push("--report");
  args.push("--input", `raíz=${writeJson(opts.raiz ?? audit([]))}`);
  args.push("--input", `web=${writeJson(opts.web ?? audit([]))}`);
  args.push("--allowlist", writeJson(opts.allowlist ?? { produccion: [], desarrollo: [] }));
  args.push("--today", opts.today ?? "2026-10-30");
  return spawnSync(process.execPath, args, { encoding: "utf8", env: { ...process.env, GITHUB_ACTIONS: "" } });
}

const ZOD = { pkg: "zod", id: "GHSA-mrhx-c7xc-m3w5", severity: "high" };
const allowZod = (vence: string, extra: Record<string, string> = {}) => ({
  produccion: [{ aviso: ZOD.id, paquete: "zod", motivo: "versión parcheada sin el mes de la política", vence, ...extra }],
  desarrollo: [],
});

test("checkAudit: sin avisos de producción → OK", () => {
  const r = run({});
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /OK: sin vulnerabilidades altas\/críticas/);
});

test("checkAudit: alta de producción fuera de la allowlist → falla con el GHSA y el paquete", () => {
  const r = run({ raiz: audit([ZOD]) });
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /\[raíz\] zod — GHSA-mrhx-c7xc-m3w5 \(high\)/);
  assert.match(r.stderr, /no está en la allowlist/);
});

test("checkAudit: crítica en web/ también falla", () => {
  const r = run({ web: audit([{ pkg: "react-dom", id: "GHSA-aaaa-bbbb-cccc", severity: "critical" }]) });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\[web\] react-dom — GHSA-aaaa-bbbb-cccc \(critical\)/);
});

test("checkAudit: aviso en la allowlist vigente → no falla y lo informa", () => {
  const r = run({ raiz: audit([ZOD]), allowlist: allowZod("2026-11-11") });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /aceptado hasta el 2026-11-11: \[raíz\] zod/);
});

test("checkAudit: ítem de la allowlist vencido → falla (aparezca o no el aviso)", () => {
  // El día `vence` ya falla: es cuando la versión parcheada cumple el mes.
  const conAviso = run({ raiz: audit([ZOD]), allowlist: allowZod("2026-11-11"), today: "2026-11-11" });
  assert.equal(conAviso.status, 1);
  assert.match(conAviso.stderr, /allowlist vencida: GHSA-mrhx-c7xc-m3w5 \(zod\) vencía el 2026-11-11/);
  assert.match(conAviso.stderr, /no está en la allowlist/, "vencido = ya no cubre el aviso");

  const sinAviso = run({ allowlist: allowZod("2026-10-01") });
  assert.equal(sinAviso.status, 1);
  assert.match(sinAviso.stderr, /allowlist vencida/);
});

test("checkAudit: la allowlist cubre solo el aviso, el paquete y el proyecto indicados", () => {
  const otroAviso = run({
    raiz: audit([{ ...ZOD, id: "GHSA-2222-3333-4444" }]),
    allowlist: allowZod("2026-11-11"),
  });
  assert.equal(otroAviso.status, 1);

  const otroProyecto = run({ web: audit([ZOD]), allowlist: allowZod("2026-11-11", { proyecto: "raíz" }) });
  assert.equal(otroProyecto.status, 1);
  assert.match(otroProyecto.stderr, /\[web\] zod/);
});

test("checkAudit: moderadas y bajas de producción no bloquean, pero se avisan", () => {
  const r = run({
    raiz: audit([
      { pkg: "postgres", id: "GHSA-5555-6666-7777", severity: "moderate" },
      { pkg: "dotenv", id: "GHSA-8888-9999-xxxx", severity: "low" },
    ]),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /AVISO: \[raíz\] postgres — GHSA-5555-6666-7777 \(moderate\)/);
  assert.match(r.stdout, /AVISO: \[raíz\] dotenv/);
});

test("checkAudit: una transitiva cuenta una sola vez (los `via` en texto son la cadena, no avisos)", () => {
  const shellQuote = audit([{ pkg: "shell-quote", id: "GHSA-pqg4-j6r4-53mv", severity: "critical" }], {
    gel: { name: "gel", severity: "critical", isDirect: false, via: ["shell-quote"], effects: [], range: "*", nodes: [], fixAvailable: true },
  });
  const r = run({ raiz: shellQuote });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /1 problema\(s\)/);
  assert.equal(r.stderr.match(/— GHSA-pqg4-j6r4-53mv/g)?.length, 1, r.stderr);
  assert.ok(!r.stderr.includes("[raíz] gel"));
});

test("checkAudit: un reporte con error de npm (sin red, registry caído) falla cerrado", () => {
  const r = run({ raiz: { error: { code: "ENOTFOUND", summary: "request to registry failed" } } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\[raíz\].*request to registry failed/);

  const basura = run({ web: "<html>no es json</html>" });
  assert.equal(basura.status, 1);
  assert.match(basura.stderr, /\[web\] no se pudo leer/);
});

test("checkAudit: allowlist mal formada → falla", () => {
  const sinMotivo = run({ allowlist: { produccion: [{ aviso: ZOD.id, paquete: "zod", vence: "2026-11-11" }], desarrollo: [] } });
  assert.equal(sinMotivo.status, 1);
  assert.match(sinMotivo.stderr, /produccion\[0\]\): falta `motivo`/);

  const idRaro = run({ allowlist: { ...allowZod("2026-11-11"), produccion: [{ ...allowZod("2026-11-11").produccion[0], aviso: "CVE-2026-1" }] } });
  assert.equal(idRaro.status, 1);
  assert.match(idRaro.stderr, /`aviso` debe ser un id GHSA/);

  const fechaMala = run({ allowlist: allowZod("11/11/2026") });
  assert.equal(fechaMala.status, 1);
  assert.match(fechaMala.stderr, /`vence` debe ser una fecha/);

  const sinArreglos = run({ allowlist: {} });
  assert.equal(sinArreglos.status, 1);
  assert.match(sinArreglos.stderr, /faltan los arreglos/);
});

test("checkAudit --report: informativo, nunca falla; marca evaluados y SIN EVALUAR", () => {
  const vite = { pkg: "vite", id: "GHSA-9jrq-w75r-8gcw", severity: "high" };
  const nanoid = { pkg: "nanoid", id: "GHSA-28wg-ghj8-5hjv", severity: "high" };
  const r = run({
    report: true,
    web: audit([vite, nanoid]),
    allowlist: {
      produccion: [],
      desarrollo: [{ paquetes: ["vite"], avisos: [vite.id], proyecto: "web", motivo: "solo dev server", revisar: "2026-11-06" }],
    },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /high {5}vite \[GHSA-9jrq-w75r-8gcw\]/);
  assert.match(r.stdout, /evaluado \[nota 1, revisar 2026-11-06\]/);
  assert.match(r.stdout, /\[nota 1\] solo dev server/);
  assert.match(r.stdout, /nanoid \(high\) no está evaluado/);
});

test("checkAudit --report: evaluación vencida o allowlist vencida → aviso, sin fallar", () => {
  const r = run({
    report: true,
    today: "2026-12-01",
    allowlist: {
      ...allowZod("2026-11-11"),
      desarrollo: [{ paquetes: ["vite"], proyecto: "web", motivo: "solo dev server", revisar: "2026-11-06" }],
    },
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /para revisar desde el 2026-11-06: vite \(web\)/);
  assert.match(r.stdout, /allowlist vencida: GHSA-mrhx-c7xc-m3w5/);
});

test("checkAudit: la allowlist versionada (scripts/ci/auditAllowlist.json) está bien formada", () => {
  // Fecha en el pasado: valida la forma sin depender del día en que corran los tests (los
  // vencimientos los controla el job de CI, no `npm test`).
  const r = spawnSync(
    process.execPath,
    [SCRIPT, "--input", `raíz=${writeJson(audit([]))}`, "--input", `web=${writeJson(audit([]))}`, "--today", "2000-01-01"],
    { encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stderr);
});
