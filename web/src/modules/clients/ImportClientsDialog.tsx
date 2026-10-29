import { useId, useState, type ChangeEvent } from "react";
import { terminologyOf } from "../../app/navigation";
import { useSession } from "../../app/session";
import { errorMessage } from "../../lib/api";
import Dialog from "../../ui/Dialog";
import { FormError } from "../../ui/Field";
import Icon from "../../ui/Icons";
import { useToast } from "../../ui/Toast";
import { useImportClients, type ImportAction, type ImportReport, type ImportRequest } from "./clientsApi";

// ─────────────────────────────────────────────────────────────────────────────
// Asistente de importación de clientes desde un CSV (plan Pro, dueño y admin), en tres
// pasos sobre `POST /clients/import`:
//   1. Archivo: se lee en el navegador (UTF-8) y se pide la vista previa.
//   2. Columnas y vista previa: el backend detecta los encabezados y sugiere a qué dato va
//      cada columna; la persona lo ajusta y ve qué pasaría con cada fila (crear,
//      actualizar, omitir o error) antes de tocar nada.
//   3. Resultado: cuántos se crearon y actualizaron, y las filas con error y su motivo.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** "1 paciente" / "3 pacientes". */
const countLabel = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const ACTION_LABELS: Record<ImportAction, string> = {
  create: "Crear",
  update: "Actualizar",
  skip: "Omitir",
  error: "Error",
};

interface Props {
  open: boolean;
  onClose: () => void;
}

type Step = { kind: "file" } | { kind: "mapping"; report: ImportReport } | { kind: "done"; report: ImportReport };

export default function ImportClientsDialog({ open, onClose }: Props) {
  const me = useSession();
  const t = terminologyOf(me);
  const { showToast } = useToast();
  const mutation = useImportClients(me.business.id);
  const [step, setStep] = useState<Step>({ kind: "file" });
  const [file, setFile] = useState<{ name: string; csv: string } | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [request, setRequest] = useState<Omit<ImportRequest, "csv" | "commit">>({});
  const fileId = useId();
  const headerId = useId();
  const existingId = useId();

  function reset() {
    setStep({ kind: "file" });
    setFile(null);
    setFileError(null);
    setRequest({});
    mutation.reset();
  }

  function close() {
    reset();
    onClose();
  }

  function preview(next: Omit<ImportRequest, "csv" | "commit">, csv = file?.csv) {
    if (!csv) return;
    setRequest(next);
    mutation.mutate({ csv, ...next, commit: false }, { onSuccess: (report) => setStep({ kind: "mapping", report }) });
  }

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files?.[0];
    setFileError(null);
    mutation.reset();
    if (!picked) return setFile(null);
    if (picked.size > MAX_FILE_BYTES) {
      setFile(null);
      return setFileError("El archivo pesa más de 2 MB: dividilo en partes.");
    }
    const csv = await picked.text();
    setFile({ name: picked.name, csv });
  }

  function commit(report: ImportReport) {
    if (!file) return;
    mutation.mutate(
      { csv: file.csv, ...request, hasHeader: report.hasHeader, mapping: report.mapping, commit: true },
      {
        onSuccess: (done) => {
          setStep({ kind: "done", report: done });
          showToast(`Importación lista: ${done.summary.create} nuevos, ${done.summary.update} actualizados.`);
        },
      },
    );
  }

  return (
    <Dialog open={open} onClose={close} title={`Importar ${t.clients}`} wide>
      {step.kind === "file" && (
        <div className="import-step">
          <p className="settings-help">
            Subí un archivo CSV (lo exportan Excel, Google Sheets o tu sistema anterior). En el siguiente paso elegís qué dato trae cada columna y ves
            qué va a pasar con cada fila antes de importar. Si el teléfono ya es de un {t.client}, se actualiza en vez de duplicarse.
          </p>
          <div className="field">
            <label htmlFor={fileId} className="field-label">
              Archivo CSV
            </label>
            <input id={fileId} type="file" accept=".csv,text/csv,text/plain" className="input" onChange={(e) => void onFile(e)} />
            {fileError ? <p className="field-error">{fileError}</p> : <p className="field-hint">Hasta 2 MB o 5000 filas. Separado por comas o por punto y coma.</p>}
          </div>
          <FormError message={mutation.isError ? errorMessage(mutation.error) : null} />
          <div className="form-actions">
            <button type="button" className="btn btn-secondary" onClick={close}>
              Cancelar
            </button>
            <button type="button" className="btn btn-primary" disabled={!file || mutation.isPending} onClick={() => preview({})}>
              {mutation.isPending ? "Leyendo…" : "Siguiente"}
            </button>
          </div>
        </div>
      )}

      {step.kind === "mapping" && (
        <div className="import-step">
          <p className="settings-help">
            <Icon id="check" size={14} /> {file?.name}: {step.report.totalRows} {step.report.totalRows === 1 ? "fila" : "filas"}. Revisá a qué dato va
            cada columna.
          </p>
          <label className="check-row" htmlFor={headerId}>
            <input
              id={headerId}
              type="checkbox"
              checked={step.report.hasHeader}
              disabled={mutation.isPending}
              onChange={(e) => preview({ ...request, hasHeader: e.target.checked, mapping: null })}
            />
            <span>La primera fila son los nombres de las columnas</span>
          </label>

          <div className="import-columns" role="table" aria-label="Columnas del archivo">
            {step.report.columns.map((col) => {
              const name = col.header ?? `Columna ${col.index + 1}`;
              return (
                <div key={col.index} className="import-column" role="row">
                  <div className="import-column-name" role="cell">
                    <strong>{name}</strong>
                    <span className="muted">{col.samples.length ? col.samples.join(" · ") : "(vacía)"}</span>
                  </div>
                  <div role="cell">
                    <label className="visually-hidden" htmlFor={`${headerId}-col-${col.index}`}>
                      Dato de la columna {name}
                    </label>
                    <select
                      id={`${headerId}-col-${col.index}`}
                      className="input select"
                      value={step.report.mapping[String(col.index)] ?? ""}
                      disabled={mutation.isPending}
                      onChange={(e) => preview({ ...request, hasHeader: step.report.hasHeader, mapping: { ...step.report.mapping, [String(col.index)]: e.target.value || null } })}
                    >
                      <option value="">No importar</option>
                      {step.report.fields.map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="field">
            <label htmlFor={existingId} className="field-label">
              Si el teléfono ya es de un {t.client}
            </label>
            <select
              id={existingId}
              className="input select"
              value={request.onExisting ?? "update"}
              disabled={mutation.isPending}
              onChange={(e) => preview({ ...request, hasHeader: step.report.hasHeader, mapping: step.report.mapping, onExisting: e.target.value === "skip" ? "skip" : "update" })}
            >
              <option value="update">Actualizar sus datos (sin borrar lo que ya tiene)</option>
              <option value="skip">Dejarlo como está</option>
            </select>
          </div>

          <ImportSummary report={step.report} />
          <FormError message={mutation.isError ? errorMessage(mutation.error) : null} />
          <div className="form-actions">
            <button type="button" className="btn btn-secondary" onClick={reset}>
              Elegir otro archivo
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={mutation.isPending || step.report.summary.create + step.report.summary.update === 0}
              onClick={() => commit(step.report)}
            >
              {mutation.isPending ? "Un momento…" : `Importar ${countLabel(step.report.summary.create + step.report.summary.update, t.client, t.clients)}`}
            </button>
          </div>
        </div>
      )}

      {step.kind === "done" && (
        <div className="import-step">
          <p className="import-done" role="status">
            <Icon id="check" size={18} />
            Se crearon {step.report.summary.create} y se actualizaron {step.report.summary.update} {t.clients}.
            {step.report.summary.skip > 0 && ` ${step.report.summary.skip} quedaron como estaban.`}
          </p>
          {step.report.errors.length > 0 && <ImportErrors report={step.report} />}
          <div className="form-actions">
            <button type="button" className="btn btn-primary" onClick={close}>
              Listo
            </button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

function ImportSummary({ report }: { report: ImportReport }) {
  const { summary } = report;
  return (
    <section className="import-summary" aria-label="Vista previa">
      <ul className="import-counts">
        <li>
          <strong>{summary.create}</strong> nuevos
        </li>
        <li>
          <strong>{summary.update}</strong> a actualizar
        </li>
        {summary.skip > 0 && (
          <li>
            <strong>{summary.skip}</strong> se omiten
          </li>
        )}
        <li className={summary.error > 0 ? "has-errors" : undefined}>
          <strong>{summary.error}</strong> con errores
        </li>
      </ul>
      <div className="import-preview-wrap">
        <table className="import-preview">
          <caption className="visually-hidden">Primeras filas</caption>
          <thead>
            <tr>
              <th scope="col">Fila</th>
              <th scope="col">Qué pasa</th>
              <th scope="col">Nombre</th>
              <th scope="col">Teléfono</th>
            </tr>
          </thead>
          <tbody>
            {report.preview.map((r) => (
              <tr key={r.row} className={r.action === "error" ? "import-row-error" : undefined}>
                <td className="tnum">{r.row}</td>
                <td>
                  <span className={`badge import-action-${r.action}`}>{ACTION_LABELS[r.action]}</span>
                  {r.errors.length > 0 && <span className="import-row-msg">{r.errors.join(" ")}</span>}
                </td>
                <td>{r.name ?? <span className="muted">—</span>}</td>
                <td className="tnum">{r.phone ?? <span className="muted">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {report.errors.length > 0 && <ImportErrors report={report} />}
    </section>
  );
}

function ImportErrors({ report }: { report: ImportReport }) {
  return (
    <details className="import-errors" open={report.committed}>
      <summary>
        {report.errors.length === 1 ? "1 fila con error" : `${report.errors.length} filas con error`} (no se importan)
      </summary>
      <ul>
        {report.errors.map((e) => (
          <li key={e.row}>
            <strong>Fila {e.row}:</strong> {e.messages.join(" ")}
          </li>
        ))}
      </ul>
    </details>
  );
}
