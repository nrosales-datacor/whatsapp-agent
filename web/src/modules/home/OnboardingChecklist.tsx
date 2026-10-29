import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { capitalize, terminologyOf } from "../../app/navigation";
import { useSession } from "../../app/session";
import { errorMessage } from "../../lib/api";
import type { OnboardingStepId, Terminology } from "../../lib/contract";
import Icon from "../../ui/Icons";
import { useToast } from "../../ui/Toast";
import { dismissOnboarding, ONBOARDING_QUERY_KEY, useOnboarding } from "./onboardingApi";

// ─────────────────────────────────────────────────────────────────────────────
// Primeros pasos (Inicio, dueño y admin de un negocio nuevo): horario, servicios, equipo,
// WhatsApp (si el plan lo trae) y la primera cita. Cada paso lo detecta el backend con lo
// que ya está cargado; la tarjeta se va sola al completarse o al ocultarla.
// ─────────────────────────────────────────────────────────────────────────────

function stepCopy(id: OnboardingStepId, t: Terminology): { title: string; help: string; to: string; cta: string } {
  switch (id) {
    case "hours":
      return { title: "Revisá el horario de atención", help: `Es el que usan la agenda y el agente para ofrecer ${t.appointments}.`, to: "/settings/locations", cta: "Ver horario" };
    case "services":
      return { title: "Cargá tus servicios y precios", help: "Te dejamos ejemplos de tu rubro: ajustá nombres, duraciones y precios.", to: "/settings/services", cta: "Ver servicios" };
    case "team":
      return { title: "Sumá a tu equipo", help: `${capitalize(t.staff)} con su horario: sin eso no hay lugar para agendar.`, to: "/settings/team", cta: "Agregar" };
    case "whatsapp":
      return { title: "Conectá tu WhatsApp", help: "El agente responde, agenda y recuerda las citas por vos.", to: "/whatsapp/settings", cta: "Conectar" };
    case "first_appointment":
      return { title: `Agendá tu primera ${t.appointment}`, help: "Probá la agenda con una de verdad (o de prueba).", to: "/agenda", cta: "Abrir la agenda" };
  }
}

export default function OnboardingChecklist() {
  const me = useSession();
  const t = terminologyOf(me);
  const qc = useQueryClient();
  const { showToast } = useToast();
  const manager = me.role === "owner" || me.role === "admin";
  const query = useOnboarding(manager);
  const dismiss = useMutation({
    mutationFn: dismissOnboarding,
    onSuccess: (data) => {
      qc.setQueryData(ONBOARDING_QUERY_KEY, data);
      showToast("Listo, ocultamos los primeros pasos. Todo sigue en Configuración.");
    },
    onError: (error) => showToast(errorMessage(error)),
  });

  if (!manager || !query.data?.visible) return null;
  const { steps } = query.data;
  const done = steps.filter((s) => s.done).length;

  return (
    <section className="card onboarding" aria-labelledby="onboarding-title">
      <div className="onboarding-head">
        <div>
          <h2 id="onboarding-title" className="card-title">
            Primeros pasos
          </h2>
          <p className="muted">
            <span className="tnum">
              {done} de {steps.length}
            </span>{" "}
            listos · lo justo para empezar a usar {me.business.name}.
          </p>
        </div>
        <button type="button" className="link-button" onClick={() => dismiss.mutate()} disabled={dismiss.isPending}>
          Ocultar
        </button>
      </div>
      <div className="onboarding-progress" role="progressbar" aria-label="Primeros pasos" aria-valuemin={0} aria-valuemax={steps.length} aria-valuenow={done}>
        <span style={{ width: `${Math.round((done / steps.length) * 100)}%` }} />
      </div>
      <ol className="onboarding-steps">
        {steps.map((s) => {
          const copy = stepCopy(s.id, t);
          return (
            <li key={s.id} className={"onboarding-step" + (s.done ? " done" : "")}>
              <span className="onboarding-check" aria-hidden="true">
                {s.done ? <Icon id="check" size={14} strokeWidth={2.4} /> : null}
              </span>
              <span className="onboarding-text">
                <span className="onboarding-title">
                  {copy.title}
                  <span className="visually-hidden">{s.done ? " (listo)" : " (pendiente)"}</span>
                </span>
                {!s.done && <span className="muted">{copy.help}</span>}
              </span>
              {!s.done && (
                <Link className="btn btn-secondary onboarding-cta" to={copy.to}>
                  {copy.cta}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
