import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { terminologyOf } from "../../app/navigation";
import { useSession } from "../../app/session";
import { errorMessage } from "../../lib/api";
import { centsToInput, currencySymbol, formatCents, parseAmountToCents } from "../../lib/money";
import Dialog from "../../ui/Dialog";
import EmptyState from "../../ui/EmptyState";
import ErrorState from "../../ui/ErrorState";
import { FormError, SelectField, TextField } from "../../ui/Field";
import Icon from "../../ui/Icons";
import { useToast } from "../../ui/Toast";
import { CheckRow, ConfirmDialog, fieldErrorOf, LoadingState, moveId, mutationError, OrderButtons, ReadOnlyNotice } from "./common";
import { canManageSettings, SETTINGS_KEYS, settingsApi, type CategoryView, type LocationView, type ServiceInput, type ServiceView } from "./settingsApi";

// Configuración > Servicios: categorías y servicios en su orden (subir/bajar), con
// duración, preparación, precio en la moneda del negocio (céntimos en la API), precio
// variable, reservable por el agente, activo y sucursales donde se ofrece.

type Dialogs =
  | { kind: "category"; category: CategoryView | null }
  | { kind: "deleteCategory"; category: CategoryView }
  | { kind: "service"; service: ServiceView | null; categoryId: string | null }
  | { kind: "deleteService"; service: ServiceView }
  | null;

const UNCATEGORIZED = "Sin categoría";

/** "60 min + 10 de preparación". */
export function durationLabel(s: Pick<ServiceView, "durationMin" | "bufferMin">): string {
  return s.bufferMin > 0 ? `${s.durationMin} min + ${s.bufferMin} de preparación` : `${s.durationMin} min`;
}

/** "₡25 000", "Desde ₡12 000" o "Sin precio". */
export function priceLabel(s: Pick<ServiceView, "priceCents" | "variablePrice">, currency: string): string {
  if (s.priceCents === 0) return s.variablePrice ? "Precio a cotizar" : "Sin precio";
  return `${s.variablePrice ? "Desde " : ""}${formatCents(s.priceCents, currency)}`;
}

export default function ServicesPage() {
  const me = useSession();
  const canEdit = canManageSettings(me);
  const qc = useQueryClient();
  const catalogQuery = useQuery({ queryKey: SETTINGS_KEYS.catalog, queryFn: settingsApi.getCatalog });
  const locationsQuery = useQuery({ queryKey: SETTINGS_KEYS.locations, queryFn: settingsApi.listLocations });
  const [dialog, setDialog] = useState<Dialogs>(null);
  const { showToast } = useToast();
  const close = () => setDialog(null);

  const reorder = useMutation({
    mutationFn: (op: { kind: "categories"; ids: string[] } | { kind: "services"; categoryId: string | null; ids: string[] }) =>
      op.kind === "categories" ? settingsApi.reorderCategories(op.ids) : settingsApi.reorderServices(op.categoryId, op.ids),
    onSettled: () => void qc.invalidateQueries({ queryKey: SETTINGS_KEYS.catalog }),
    onError: (error) => showToast(errorMessage(error, "No pudimos cambiar el orden.")),
  });

  if (catalogQuery.isPending) return <LoadingState />;
  if (catalogQuery.isError) return <ErrorState message={errorMessage(catalogQuery.error, "No pudimos cargar los servicios.")} onRetry={() => void catalogQuery.refetch()} />;
  const { categories, services } = catalogQuery.data;
  const locations = locationsQuery.data ?? [];
  const groups: { category: CategoryView | null; services: ServiceView[] }[] = [
    ...categories.map((c) => ({ category: c, services: services.filter((s) => s.categoryId === c.id) })),
    { category: null, services: services.filter((s) => s.categoryId === null) },
  ].filter((g) => g.category !== null || g.services.length > 0);

  return (
    <div className="settings-stack">
      {!canEdit && <ReadOnlyNotice />}
      {canEdit && (
        <div className="settings-toolbar">
          <button type="button" className="btn btn-secondary" onClick={() => setDialog({ kind: "category", category: null })}>
            <Icon id="plus" size={16} />
            Nueva categoría
          </button>
          <button type="button" className="btn btn-primary" onClick={() => setDialog({ kind: "service", service: null, categoryId: categories[0]?.id ?? null })}>
            <Icon id="plus" size={16} />
            Nuevo servicio
          </button>
        </div>
      )}

      {groups.length === 0 && (
        <EmptyState icon="receipt" title="Todavía no hay servicios" help="Creá una categoría y tus servicios con su duración y precio." />
      )}

      {groups.map(({ category, services: list }) => {
        const title = category?.name ?? UNCATEGORIZED;
        const catIndex = category ? categories.findIndex((c) => c.id === category.id) : -1;
        return (
          <section key={category?.id ?? "none"} className="category-block" aria-label={title}>
            <div className="category-head">
              <h3>{title}</h3>
              {canEdit && category && (
                <div className="settings-item-actions">
                  <OrderButtons
                    index={catIndex}
                    count={categories.length}
                    label={`la categoría ${title}`}
                    disabled={reorder.isPending}
                    onMove={(from, to) => reorder.mutate({ kind: "categories", ids: moveId(categories.map((c) => c.id), from, to) })}
                  />
                  <button type="button" className="icon-btn" aria-label={`Renombrar la categoría ${title}`} onClick={() => setDialog({ kind: "category", category })}>
                    <Icon id="pencil" size={18} />
                  </button>
                  <button type="button" className="icon-btn danger" aria-label={`Eliminar la categoría ${title}`} onClick={() => setDialog({ kind: "deleteCategory", category })}>
                    <Icon id="trash" size={18} />
                  </button>
                </div>
              )}
            </div>
            {list.length === 0 ? (
              <p className="settings-help">Sin servicios en esta categoría.</p>
            ) : (
              <ul className="settings-list">
                {list.map((s, i) => (
                  <li key={s.id} className={"settings-item" + (s.active ? "" : " inactive")}>
                    <div className="settings-item-main">
                      <span className="settings-item-title">
                        {s.name}
                        {!s.active && <span className="badge badge-muted">Inactivo</span>}
                        {!s.onlineBooking && <span className="badge badge-info">Solo desde el panel</span>}
                      </span>
                      <span className="settings-item-meta">
                        {durationLabel(s)} · {priceLabel(s, me.business.currency)}
                        {s.locationIds.length > 0 && ` · Solo en ${locationNames(s.locationIds, locations)}`}
                      </span>
                    </div>
                    {canEdit && (
                      <div className="settings-item-actions">
                        <OrderButtons
                          index={i}
                          count={list.length}
                          label={s.name}
                          disabled={reorder.isPending}
                          onMove={(from, to) => reorder.mutate({ kind: "services", categoryId: s.categoryId, ids: moveId(list.map((x) => x.id), from, to) })}
                        />
                        <button type="button" className="icon-btn" aria-label={`Editar ${s.name}`} onClick={() => setDialog({ kind: "service", service: s, categoryId: s.categoryId })}>
                          <Icon id="pencil" size={18} />
                        </button>
                        <button type="button" className="icon-btn danger" aria-label={`Eliminar ${s.name}`} onClick={() => setDialog({ kind: "deleteService", service: s })}>
                          <Icon id="trash" size={18} />
                        </button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}

      {dialog?.kind === "category" && <CategoryDialog category={dialog.category} onClose={close} />}
      {dialog?.kind === "deleteCategory" && <DeleteCategoryDialog category={dialog.category} onClose={close} />}
      {dialog?.kind === "service" && (
        <ServiceDialog service={dialog.service} defaultCategoryId={dialog.categoryId} categories={categories} locations={locations} onClose={close} />
      )}
      {dialog?.kind === "deleteService" && <DeleteServiceDialog service={dialog.service} onClose={close} />}
    </div>
  );
}

function locationNames(ids: string[], locations: LocationView[]): string {
  return ids.map((id) => locations.find((l) => l.id === id)?.name ?? "otra sucursal").join(", ");
}

function useCatalogInvalidation() {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: SETTINGS_KEYS.catalog });
}

function CategoryDialog({ category, onClose }: { category: CategoryView | null; onClose: () => void }) {
  const invalidate = useCatalogInvalidation();
  const { showToast } = useToast();
  const [name, setName] = useState(category?.name ?? "");
  const [localError, setLocalError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: () => (category ? settingsApi.renameCategory(category.id, name.trim()) : settingsApi.createCategory(name.trim())),
    onSuccess: (saved) => {
      invalidate();
      showToast(category ? "Listo, la categoría quedó renombrada." : `Listo, la categoría «${saved.name}» quedó creada.`);
      onClose();
    },
  });
  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setLocalError("Escribí el nombre.");
    setLocalError(null);
    mutation.mutate();
  }
  return (
    <Dialog open onClose={onClose} title={category ? "Renombrar categoría" : "Nueva categoría"}>
      <form onSubmit={onSubmit} noValidate>
        <TextField label="Nombre de la categoría" value={name} maxLength={80} autoFocus error={localError ?? fieldErrorOf(mutation.error, "name")} onChange={(e) => setName(e.target.value)} />
        <FormError message={mutationError(mutation.error)} />
        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary" disabled={mutation.isPending}>
            {mutation.isPending ? "Guardando…" : "Guardar"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function DeleteCategoryDialog({ category, onClose }: { category: CategoryView; onClose: () => void }) {
  const invalidate = useCatalogInvalidation();
  const { showToast } = useToast();
  const mutation = useMutation({
    mutationFn: () => settingsApi.deleteCategory(category.id),
    onSuccess: () => {
      invalidate();
      showToast(`La categoría «${category.name}» quedó eliminada.`);
      onClose();
    },
  });
  return (
    <ConfirmDialog
      open
      title={`¿Eliminar la categoría ${category.name}?`}
      confirmLabel="Eliminar"
      danger
      pending={mutation.isPending}
      error={mutationError(mutation.error)}
      onConfirm={() => mutation.mutate()}
      onClose={onClose}
    >
      <p>Sus servicios no se borran: pasan a «{UNCATEGORIZED}».</p>
    </ConfirmDialog>
  );
}

function DeleteServiceDialog({ service, onClose }: { service: ServiceView; onClose: () => void }) {
  const me = useSession();
  const t = terminologyOf(me);
  const invalidate = useCatalogInvalidation();
  const { showToast } = useToast();
  const mutation = useMutation({
    mutationFn: () => settingsApi.deleteService(service.id),
    onSuccess: () => {
      invalidate();
      showToast(`«${service.name}» quedó eliminado.`);
      onClose();
    },
  });
  return (
    <ConfirmDialog
      open
      title={`¿Eliminar ${service.name}?`}
      confirmLabel="Eliminar"
      danger
      pending={mutation.isPending}
      error={mutationError(mutation.error)}
      onConfirm={() => mutation.mutate()}
      onClose={onClose}
    >
      <p>
        Las {t.appointments} que ya lo tienen conservan su nombre y precio. Si solo querés dejar de ofrecerlo, editalo y desmarcá «Activo».
      </p>
    </ConfirmDialog>
  );
}

const DURATION_OPTIONS = Array.from({ length: 48 }, (_, i) => (i + 1) * 5).filter((m) => m <= 120 || m % 15 === 0);
const durationText = (m: number) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`);

interface ServiceDialogProps {
  service: ServiceView | null;
  defaultCategoryId: string | null;
  categories: CategoryView[];
  locations: LocationView[];
  onClose: () => void;
}

function ServiceDialog({ service, defaultCategoryId, categories, locations, onClose }: ServiceDialogProps) {
  const me = useSession();
  const t = terminologyOf(me);
  const currency = me.business.currency;
  const invalidate = useCatalogInvalidation();
  const { showToast } = useToast();
  const [form, setForm] = useState({
    name: service?.name ?? "",
    categoryId: service ? (service.categoryId ?? "") : (defaultCategoryId ?? ""),
    description: service?.description ?? "",
    durationMin: service?.durationMin ?? 60,
    bufferMin: service?.bufferMin ?? 0,
    price: service ? centsToInput(service.priceCents) : "",
    variablePrice: service?.variablePrice ?? false,
    onlineBooking: service?.onlineBooking ?? true,
    active: service?.active ?? true,
    locationIds: service?.locationIds ?? [],
  });
  const [localErrors, setLocalErrors] = useState<Record<string, string>>({});
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((f) => ({ ...f, [key]: value }));

  const mutation = useMutation({
    mutationFn: (input: ServiceInput) => (service ? settingsApi.updateService(service.id, input) : settingsApi.createService(input)),
    onSuccess: (saved) => {
      invalidate();
      showToast(service ? `Listo, «${saved.name}» quedó guardado.` : `Listo, «${saved.name}» quedó creado.`);
      onClose();
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const errors: Record<string, string> = {};
    if (!form.name.trim()) errors.name = "Escribí el nombre del servicio.";
    const priceCents = parseAmountToCents(form.price);
    if (priceCents === null) errors.price = "Escribí un monto válido (ej. 25000 o 25000,50).";
    setLocalErrors(errors);
    if (Object.keys(errors).length > 0 || priceCents === null) return;
    mutation.mutate({
      name: form.name.trim(),
      categoryId: form.categoryId || null,
      description: form.description.trim() || null,
      durationMin: form.durationMin,
      bufferMin: form.bufferMin,
      priceCents,
      variablePrice: form.variablePrice,
      onlineBooking: form.onlineBooking,
      active: form.active,
      locationIds: form.locationIds,
    });
  }

  const err = (field: string) => localErrors[field] ?? fieldErrorOf(mutation.error, field);
  const durationOptions = [...new Set([...DURATION_OPTIONS, form.durationMin])].sort((a, b) => a - b);
  return (
    <Dialog open onClose={onClose} title={service ? `Editar ${service.name}` : "Nuevo servicio"} wide>
      <form onSubmit={onSubmit} noValidate>
        <div className="form-grid">
          <TextField label="Nombre" value={form.name} maxLength={120} autoFocus error={err("name")} onChange={(e) => set("name", e.target.value)} />
          <SelectField
            label="Categoría"
            value={form.categoryId}
            options={[...categories.map((c) => ({ value: c.id, label: c.name })), { value: "", label: UNCATEGORIZED }]}
            error={err("categoryId")}
            onChange={(e) => set("categoryId", e.target.value)}
          />
        </div>
        <TextField label="Descripción (opcional)" value={form.description} maxLength={1000} error={err("description")} onChange={(e) => set("description", e.target.value)} />
        <div className="form-grid">
          <SelectField
            label="Duración"
            value={String(form.durationMin)}
            options={durationOptions.map((m) => ({ value: String(m), label: durationText(m) }))}
            error={err("durationMin")}
            onChange={(e) => set("durationMin", Number(e.target.value))}
          />
          <SelectField
            label="Preparación después"
            hint={`Ocupa al ${t.staffMember}, no se le muestra al ${t.client}.`}
            value={String(form.bufferMin)}
            options={[0, 5, 10, 15, 20, 30, 45, 60].map((m) => ({ value: String(m), label: m === 0 ? "Sin preparación" : `${m} min` }))}
            error={err("bufferMin")}
            onChange={(e) => set("bufferMin", Number(e.target.value))}
          />
          <div className="field">
            <div className="field-label-row">
              <label htmlFor="service-price" className="field-label">
                Precio ({currency})
              </label>
            </div>
            <div className="money-field">
              <span aria-hidden="true">{currencySymbol(currency)}</span>
              <input
                id="service-price"
                className="input"
                inputMode="decimal"
                autoComplete="off"
                placeholder="0"
                value={form.price}
                aria-invalid={err("price") || err("priceCents") ? true : undefined}
                aria-describedby="service-price-help"
                onChange={(e) => set("price", e.target.value)}
              />
            </div>
            {err("price") || err("priceCents") ? (
              <p id="service-price-help" className="field-error">
                {err("price") ?? err("priceCents")}
              </p>
            ) : (
              <p id="service-price-help" className="field-hint">
                {form.price.trim() ? `Se muestra como ${formatCents(parseAmountToCents(form.price) ?? 0, currency)}.` : "Vacío = sin precio."}
              </p>
            )}
          </div>
        </div>
        <div className="check-list field">
          <CheckRow label="Precio variable" hint="El precio es «desde»: se confirma según el caso." checked={form.variablePrice} onChange={(v) => set("variablePrice", v)} />
          <CheckRow label="Reservable por el agente y en línea" hint="Si no, solo se agenda desde el panel." checked={form.onlineBooking} onChange={(v) => set("onlineBooking", v)} />
          <CheckRow label="Activo" hint="Un servicio inactivo no se ofrece en la agenda ni en el agente." checked={form.active} onChange={(v) => set("active", v)} />
        </div>
        {locations.length > 1 && (
          <fieldset className="field">
            <legend>{`¿En qué ${t.locations} se ofrece?`}</legend>
            <p className="settings-help">Sin marcar ninguna = en todas.</p>
            <div className="check-list">
              {locations.map((l) => (
                <CheckRow
                  key={l.id}
                  label={l.name + (l.active ? "" : " (inactiva)")}
                  checked={form.locationIds.includes(l.id)}
                  onChange={(v) => set("locationIds", v ? [...form.locationIds, l.id] : form.locationIds.filter((id) => id !== l.id))}
                />
              ))}
            </div>
          </fieldset>
        )}
        <FormError message={mutationError(mutation.error)} />
        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary" disabled={mutation.isPending}>
            {mutation.isPending ? "Guardando…" : "Guardar"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
