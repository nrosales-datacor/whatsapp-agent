import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  adminAuditoriaTenant,
  adminBorrarCliente,
  adminProbarWhatsapp,
  adminReconectarWhatsapp,
  type TenantResumen,
} from "../../api";
import ErrorState from "../ErrorState";

// ─────────────────────────────────────────────────────────────────────────────
// Acciones de plataforma sobre UN negocio (revisión pre-venta 2026-10), en el detalle
// expandido de la lista del admin: reconectar WhatsApp + mensaje de prueba, borrar los
// datos de un cliente final (Ley 8968) e historial auditable. Pausar/reactivar vive en
// la fila de la tabla (ListaNegocios), que es la acción frecuente del cobro manual.
// ─────────────────────────────────────────────────────────────────────────────

const ETIQUETA_ACCION: Record<string, string> = {
  pausar: "Pausado",
  reactivar: "Reactivado",
  reconectar_whatsapp: "WhatsApp reconectado",
  borrar_cliente: "Datos de un cliente borrados",
  baja_tenant: "Negocio dado de baja",
  baja_storage_pendiente: "Baja: fotos pendientes de borrar",
};

export default function AccionesNegocio({ tenant }: { tenant: TenantResumen }) {
  return (
    <div className="admin-acciones">
      <WhatsappNegocio tenant={tenant} />
      <BorrarClienteNegocio tenantId={tenant.id} />
      <HistorialNegocio tenantId={tenant.id} />
    </div>
  );
}

function WhatsappNegocio({ tenant }: { tenant: TenantResumen }) {
  const qc = useQueryClient();
  const [pnid, setPnid] = useState(tenant.phoneNumberId);
  const [token, setToken] = useState("");
  const [para, setPara] = useState("");
  const [okMsg, setOkMsg] = useState("");

  const reconectar = useMutation({
    mutationFn: () => adminReconectarWhatsapp(tenant.id, { phoneNumberId: pnid.trim(), accessToken: token.trim() }),
    onSuccess: () => {
      setToken("");
      setOkMsg("Conexión guardada. Probala con un mensaje de prueba.");
      qc.invalidateQueries({ queryKey: ["adminTenants"] });
      qc.invalidateQueries({ queryKey: ["adminAuditoria", tenant.id] });
    },
  });
  const probar = useMutation({
    mutationFn: () => adminProbarWhatsapp(tenant.id, para.trim()),
    onSuccess: () => setOkMsg("Mensaje de prueba enviado."),
  });

  const estado = !tenant.whatsappConectado
    ? "Sin token: el bot no puede enviar mensajes."
    : tenant.whatsappTokenGlobal
      ? "Envía con el token global del piloto (no tiene uno propio)."
      : "Conectado con su token propio.";

  return (
    <div className="card">
      <h4>WhatsApp</h4>
      <p className="admin-hint">{estado}</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setOkMsg("");
          if (confirm(`¿Reemplazar la conexión de WhatsApp de "${tenant.nombre}"? El token anterior deja de usarse.`)) {
            reconectar.mutate();
          }
        }}
      >
        <div className="admin-grid">
          <div className="campo">
            <label htmlFor={`rPnid-${tenant.id}`}>phone_number_id</label>
            <input id={`rPnid-${tenant.id}`} value={pnid} onChange={(e) => setPnid(e.target.value)} required />
          </div>
          <div className="campo">
            <label htmlFor={`rToken-${tenant.id}`}>access token nuevo</label>
            <input
              id={`rToken-${tenant.id}`}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="EAA…"
              autoComplete="off"
              required
            />
          </div>
        </div>
        <button type="submit" className="btn-ghost" disabled={reconectar.isPending}>
          {reconectar.isPending ? "Guardando…" : "Reconectar WhatsApp"}
        </button>
      </form>
      {reconectar.isError && <div className="admin-error">{reconectar.error.message}</div>}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          setOkMsg("");
          probar.mutate();
        }}
      >
        <div className="campo">
          <label htmlFor={`rPara-${tenant.id}`}>Enviar mensaje de prueba a</label>
          <input
            id={`rPara-${tenant.id}`}
            value={para}
            onChange={(e) => setPara(e.target.value)}
            placeholder="ej: 50688887777"
            inputMode="tel"
            required
          />
        </div>
        <p className="admin-hint">
          Meta solo entrega texto libre si ese número le escribió al negocio en las últimas 24 h. Un error 131047
          (fuera de ventana) igual confirma que el token y el número funcionan.
        </p>
        <button type="submit" className="btn-ghost" disabled={probar.isPending}>
          {probar.isPending ? "Enviando…" : "Enviar mensaje de prueba"}
        </button>
      </form>
      {probar.isError && <div className="admin-error">Graph respondió: {probar.error.message}</div>}
      {okMsg && <div className="admin-ok">{okMsg}</div>}
    </div>
  );
}

function BorrarClienteNegocio({ tenantId }: { tenantId: string }) {
  const qc = useQueryClient();
  const [tel, setTel] = useState("");
  const [confirmacion, setConfirmacion] = useState("");
  const borrar = useMutation({
    mutationFn: () => adminBorrarCliente(tenantId, tel.trim(), confirmacion.trim()),
    onSuccess: () => {
      setTel("");
      setConfirmacion("");
      qc.invalidateQueries({ queryKey: ["adminAuditoria", tenantId] });
    },
  });

  return (
    <div className="card">
      <h4>Borrar datos de un cliente (Ley 8968)</h4>
      <p className="admin-hint">
        Borra de forma definitiva el chat, citas, cotizaciones, fotos y eventos futuros de Calendar de ese cliente en
        este negocio. No se puede deshacer.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (confirm("¿Borrar definitivamente todos los datos de este cliente? No se puede deshacer.")) borrar.mutate();
        }}
      >
        <div className="admin-grid">
          <div className="campo">
            <label htmlFor={`bTel-${tenantId}`}>Teléfono del cliente</label>
            <input id={`bTel-${tenantId}`} value={tel} onChange={(e) => setTel(e.target.value)} placeholder="50688887777" required />
          </div>
          <div className="campo">
            <label htmlFor={`bConf-${tenantId}`}>Repetí el teléfono para confirmar</label>
            <input id={`bConf-${tenantId}`} value={confirmacion} onChange={(e) => setConfirmacion(e.target.value)} required />
          </div>
        </div>
        <button type="submit" className="btn-ghost" disabled={borrar.isPending}>
          {borrar.isPending ? "Borrando…" : "Borrar datos del cliente"}
        </button>
      </form>
      {borrar.isError && <div className="admin-error">{borrar.error.message}</div>}
      {borrar.isSuccess && (
        <div className="admin-ok">
          Listo: {borrar.data.conteos.mensajes ?? 0} mensajes, {borrar.data.conteos.citas ?? 0} citas,{" "}
          {borrar.data.archivosStorage} fotos y {borrar.data.eventosCalendario} eventos de Calendar borrados.
        </div>
      )}
    </div>
  );
}

function HistorialNegocio({ tenantId }: { tenantId: string }) {
  const [abierto, setAbierto] = useState(false);
  const q = useQuery({
    queryKey: ["adminAuditoria", tenantId],
    queryFn: () => adminAuditoriaTenant(tenantId),
    enabled: abierto,
  });

  return (
    <div className="card">
      <h4>Historial</h4>
      <button type="button" className="btn-ghost" onClick={() => setAbierto((a) => !a)}>
        {abierto ? "Ocultar historial" : "Ver historial"}
      </button>
      {abierto &&
        (q.isLoading ? (
          <div className="admin-vacio">Cargando…</div>
        ) : q.isError ? (
          <ErrorState mensaje="No se pudo cargar el historial." onReintentar={() => q.refetch()} />
        ) : (q.data ?? []).length === 0 ? (
          <div className="admin-vacio">Sin registros todavía.</div>
        ) : (
          <table className="admin-tabla">
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Acción</th>
                <th>Quién</th>
                <th>Detalle</th>
              </tr>
            </thead>
            <tbody>
              {(q.data ?? []).map((e) => (
                <tr key={e.id}>
                  <td>{new Date(e.creadoEn).toLocaleString("es-CR")}</td>
                  <td>{ETIQUETA_ACCION[e.accion] ?? e.accion}</td>
                  <td>{e.actor}</td>
                  <td>{typeof e.detalle.motivo === "string" ? e.detalle.motivo : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
    </div>
  );
}
