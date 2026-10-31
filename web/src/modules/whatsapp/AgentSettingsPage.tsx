import { useEffect, useId, useState, type ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useSession } from "../../app/session";
import { errorMessage, isApiError } from "../../lib/api";
import ErrorState from "../../ui/ErrorState";
import { FormError, SelectField, TextField } from "../../ui/Field";
import { useToast } from "../../ui/Toast";
import ChannelsSection from "./ChannelsSection";
import { FaqEditor, KnowledgeEditor } from "./KnowledgeEditor";
import { useAgentSettings, useSaveAgentSettings, type AgentSettings, type Register } from "./whatsappApi";
import { AGENT_MANAGERS } from "./WhatsappLayout";

const REGISTER_OPTIONS: readonly { value: Register; label: string }[] = [
  { value: "vos", label: "Vos (cercano)" },
  { value: "tu", label: "Tú (cercano)" },
  { value: "usted", label: "Usted (formal)" },
];

/**
 * Textos fijos que el dueño puede reemplazar (claves del catálogo del backend:
 * src/modules/whatsapp/texts.ts y agent/texts.ts). Vacío = el texto por defecto, en el
 * registro del negocio. Las claves guardadas que no estén acá se muestran con su nombre.
 */
const TEXT_LABELS: Record<string, { label: string; hint?: string }> = {
  botNotice: {
    label: "Aviso de asistente automático",
    hint: "Va antes del primer mensaje automático. Variable: {negocio}. Al final siempre se agrega la línea de privacidad (respuestas con IA y enlace a la política de privacidad).",
  },
  handoff: { label: "Al pasar a una persona", hint: "Lo que dice el agente cuando la conversación pasa al equipo." },
  humanRequested: { label: "Cuando piden hablar con una persona" },
  notUnderstood: { label: "Cuando no entiende el mensaje" },
  optOutAck: { label: "Al pedir la baja de promociones (BAJA)" },
  marketingConsentQuestion: { label: "Pregunta de promociones", hint: "Tras la primera cita, si tenés Campañas. Variable: {negocio}." },
  followUpQuestion: { label: "Seguimiento después del servicio", hint: "Variables: {cliente}, {servicio}, {negocio}." },
  quoteFirstTouch: { label: "Rescate de una cotización", hint: "Variables: {servicio}, {monto}." },
};

const MAX_TONE = 200;
const MAX_INSTRUCTIONS = 4000;

function textLabel(key: string): { label: string; hint?: string } {
  if (TEXT_LABELS[key]) return TEXT_LABELS[key];
  const words = key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase();
  return { label: words.charAt(0).toUpperCase() + words.slice(1) };
}

function slug(text: string): string {
  return (
    text
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "seccion"
  );
}

interface Problems {
  knowledge: Record<number, string>;
  faq: Record<number, string>;
}

/** Limpia el borrador para guardar (filas vacías fuera, ids de secciones nuevas) y junta los errores. */
function prepare(draft: AgentSettings): { settings: AgentSettings; problems: Problems | null } {
  const problems: Problems = { knowledge: {}, faq: {} };
  const used = new Set(draft.knowledge.map((s) => s.id).filter(Boolean));
  const knowledge: AgentSettings["knowledge"] = [];
  draft.knowledge.forEach((section, i) => {
    const title = section.title.trim();
    const items = section.items.map((x) => x.trim()).filter(Boolean);
    if (!title && items.length === 0) return;
    if (!title) problems.knowledge[i] = "Poné un título a la sección.";
    let id = section.id;
    if (!id) {
      const base = slug(title);
      id = base;
      for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
      used.add(id);
    }
    knowledge.push({ id, title, items });
  });
  const faq: AgentSettings["faq"] = [];
  draft.faq.forEach((entry, i) => {
    const question = entry.question.trim();
    const answer = entry.answer.trim();
    if (!question && !answer) return;
    if (!question || !answer) problems.faq[i] = !question ? "Escribí la pregunta." : "Escribí la respuesta.";
    faq.push({ question, answer });
  });
  const texts = Object.fromEntries(Object.entries(draft.texts).map(([k, v]) => [k, v.trim()]));
  const has = Object.keys(problems.knowledge).length + Object.keys(problems.faq).length > 0;
  return {
    settings: { tone: draft.tone.trim(), register: draft.register, instructions: draft.instructions.trim(), knowledge, faq, texts },
    problems: has ? problems : null,
  };
}

/** Configuración del agente (/whatsapp/settings): cómo habla, qué sabe, sus textos y los números. */
export default function AgentSettingsPage() {
  const me = useSession();
  if (!AGENT_MANAGERS.includes(me.role)) return <Navigate to="/whatsapp" replace />;
  return <AgentSettingsContent />;
}

function AgentSettingsContent() {
  const query = useAgentSettings();
  if (query.isPending) {
    return (
      <div className="clients-loading" role="status">
        <div className="spinner" aria-hidden="true" />
        <span>Cargando la configuración del agente…</span>
      </div>
    );
  }
  if (query.isError) {
    return <ErrorState message={errorMessage(query.error, "No pudimos cargar la configuración del agente.")} onRetry={() => void query.refetch()} />;
  }
  return (
    <div className="wa-settings">
      <SettingsForm key={JSON.stringify(query.data)} saved={query.data} />
      <ChannelsSection />
    </div>
  );
}

function SettingsForm({ saved }: { saved: AgentSettings }) {
  const { showToast } = useToast();
  const save = useSaveAgentSettings(() => showToast("Cambios guardados. El agente ya responde con esta configuración."));
  const [draft, setDraft] = useState<AgentSettings>(saved);
  const [problems, setProblems] = useState<Problems | null>(null);
  const [kbFocus, setKbFocus] = useState<string | null>(null);
  const [faqFocus, setFaqFocus] = useState<string | null>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const set = <K extends keyof AgentSettings>(key: K, value: AgentSettings[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const fieldError = (name: string) => (isApiError(save.error) ? save.error.fieldError(name) : undefined);

  // Avisa antes de salir de la página con cambios sin guardar (recargar o cerrar la pestaña).
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  function submit() {
    const { settings, problems: found } = prepare(draft);
    setProblems(found);
    if (found) return;
    save.mutate(settings);
  }

  const serverMessage = save.isError ? errorMessage(save.error, "No pudimos guardar los cambios.") : null;

  return (
    <form
      className="wa-settings-form"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <section className="card wa-settings-card" aria-labelledby="wa-voice-title">
        <h2 id="wa-voice-title" className="card-title">
          Cómo habla el agente
        </h2>
        <div className="form-grid">
          <TextField
            label="Tono"
            hint="Ej.: cordial y breve; cercano y profesional."
            maxLength={MAX_TONE}
            value={draft.tone}
            onChange={(e) => set("tone", e.target.value)}
            error={fieldError("tone")}
          />
          <SelectField
            label="Trato al cliente"
            options={REGISTER_OPTIONS}
            value={draft.register}
            onChange={(e) => set("register", e.target.value as Register)}
            error={fieldError("register")}
          />
        </div>
        <TextAreaField
          label="Instrucciones"
          hint="Reglas propias de tu negocio, con tus palabras. El agente las sigue al pie de la letra."
          rows={6}
          maxLength={MAX_INSTRUCTIONS}
          placeholder={"Ej.:\n- No atendemos sin cita.\n- Si preguntan por X, respondé Y."}
          value={draft.instructions}
          onChange={(value) => set("instructions", value)}
          error={fieldError("instructions")}
        />
      </section>

      <section className="card wa-settings-card" aria-labelledby="wa-kb-title">
        <h2 id="wa-kb-title" className="card-title">
          Lo que sabe el agente
        </h2>
        <p className="settings-help">Datos que usa para responder: cada sección con su título y un dato por fila.</p>
        <KnowledgeEditor sections={draft.knowledge} onChange={(v) => set("knowledge", v)} focus={kbFocus} setFocus={setKbFocus} errors={problems?.knowledge ?? {}} />
      </section>

      <section className="card wa-settings-card" aria-labelledby="wa-faq-title">
        <h2 id="wa-faq-title" className="card-title">
          Preguntas frecuentes
        </h2>
        <FaqEditor faq={draft.faq} onChange={(v) => set("faq", v)} focus={faqFocus} setFocus={setFaqFocus} errors={problems?.faq ?? {}} />
      </section>

      <section className="card wa-settings-card" aria-labelledby="wa-texts-title">
        <h2 id="wa-texts-title" className="card-title">
          Textos del agente
        </h2>
        <p className="settings-help">Mensajes que se mandan tal cual en momentos puntuales. Vacío = el texto por defecto.</p>
        {[...new Set([...Object.keys(TEXT_LABELS), ...Object.keys(draft.texts)])].map((key) => {
          const meta = textLabel(key);
          return (
            <TextAreaField
              key={key}
              label={meta.label}
              hint={meta.hint}
              rows={2}
              value={draft.texts[key] ?? ""}
              onChange={(v) => {
                // Vacío = volver al texto por defecto: la clave no se manda (la lista se reemplaza entera).
                const next = { ...draft.texts };
                if (v) next[key] = v;
                else delete next[key];
                set("texts", next);
              }}
              error={fieldError(`texts.${key}`)}
            />
          );
        })}
      </section>

      {(dirty || save.isError) && (
        <div className="client-savebar wa-savebar" role="region" aria-label="Cambios sin guardar">
          <div className="client-savebar-text">
            {problems ? <FormError message="Revisá los campos marcados." /> : serverMessage ? <FormError message={serverMessage} /> : "Tenés cambios sin guardar."}
          </div>
          <div className="client-savebar-actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                setDraft(saved);
                setProblems(null);
                save.reset();
              }}
              disabled={save.isPending}
            >
              Descartar
            </button>
            <button type="submit" className="btn btn-primary" disabled={save.isPending}>
              {save.isPending ? "Guardando…" : "Guardar cambios"}
            </button>
          </div>
        </div>
      )}
    </form>
  );
}

interface TextAreaProps {
  label: string;
  hint?: ReactNode;
  error?: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  maxLength?: number;
  placeholder?: string;
}

/** Campo de texto largo con label, ayuda y error accesibles (mismo patrón que ui/Field). */
function TextAreaField({ label, hint, error, value, onChange, rows = 3, maxLength, placeholder }: TextAreaProps) {
  const id = useId();
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className="field">
      <div className="field-label-row">
        <label htmlFor={id} className="field-label">
          {label}
        </label>
      </div>
      <textarea
        id={id}
        className="input wa-textarea"
        rows={rows}
        maxLength={maxLength}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
      />
      {hint && !error && (
        <p id={`${id}-hint`} className="field-hint">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="field-error">
          {error}
        </p>
      )}
    </div>
  );
}
