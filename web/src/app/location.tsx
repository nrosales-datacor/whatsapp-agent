import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { setActiveLocationId } from "../lib/api";
import type { LocationRef } from "../lib/contract";
import { readStorage, writeStorage } from "../lib/storage";
import { terminologyOf } from "./navigation";
import { ME_QUERY_KEY, useSession } from "./session";

// ─────────────────────────────────────────────────────────────────────────────
// Sucursal activa (PLAN-GESTION.md §6). Dueño y admin pueden elegir "Todas"; recepción y
// profesional quedan fijos a las suyas (si tienen varias, eligen entre esas). La elección
// se recuerda por usuario y negocio en localStorage (si no se puede, se usa el default) y
// viaja en cada request como `X-Location-Id` (sin header = todas).
//
// Montalo con `key` = negocio + usuario: al cambiar de negocio se recalcula desde cero.
// ─────────────────────────────────────────────────────────────────────────────

export const ALL_LOCATIONS = "all";

interface LocationContextValue {
  /** Sucursales elegibles (sin "Todas"). */
  locations: LocationRef[];
  canSelectAll: boolean;
  /** Id de la sucursal o ALL_LOCATIONS. */
  selected: string;
  /** Nombre de lo elegido ("Escazú" o "Todas las sucursales"). */
  label: string;
  /** Texto de la opción "Todas" con la terminología del negocio. */
  allLabel: string;
  select: (id: string) => void;
}

const LocationContext = createContext<LocationContextValue | null>(null);

export function useActiveLocation(): LocationContextValue {
  const value = useContext(LocationContext);
  if (!value) throw new Error("useActiveLocation se usó fuera de LocationProvider");
  return value;
}

export function LocationProvider({ children }: { children: ReactNode }) {
  const me = useSession();
  const qc = useQueryClient();
  const t = terminologyOf(me);
  const locations = me.locations;
  // Con una sola sucursal, "Todas" es lo mismo que esa: se muestra fija.
  const canSelectAll = (me.role === "owner" || me.role === "admin") && locations.length > 1;
  const storageKey = `selyon.location.${me.user.id}.${me.business.id}`;

  const isValid = useCallback(
    (id: string | null): id is string =>
      id !== null && ((id === ALL_LOCATIONS && canSelectAll) || locations.some((l) => l.id === id)),
    [canSelectAll, locations],
  );
  const fallback = canSelectAll ? ALL_LOCATIONS : (locations[0]?.id ?? ALL_LOCATIONS);

  const [chosen, setChosen] = useState<string>(() => {
    const saved = readStorage(storageKey);
    return isValid(saved) ? saved : fallback;
  });
  const selected = isValid(chosen) ? chosen : fallback;

  // Se fija en el render (asignación idempotente) para que las queries de los hijos ya
  // salgan con el header correcto en su primer fetch.
  setActiveLocationId(selected === ALL_LOCATIONS ? null : selected);
  useEffect(() => () => setActiveLocationId(null), []);

  const select = useCallback(
    (id: string) => {
      if (!isValid(id) || id === selected) return;
      setChosen(id);
      writeStorage(storageKey, id);
      setActiveLocationId(id === ALL_LOCATIONS ? null : id);
      // Los datos que dependen de la sucursal se vuelven a pedir con el header nuevo.
      void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== ME_QUERY_KEY[0] });
    },
    [isValid, selected, storageKey, qc],
  );

  const allLabel = `Todas las ${t.locations}`;
  const value = useMemo<LocationContextValue>(
    () => ({
      locations,
      canSelectAll,
      selected,
      label: selected === ALL_LOCATIONS ? allLabel : (locations.find((l) => l.id === selected)?.name ?? allLabel),
      allLabel,
      select,
    }),
    [locations, canSelectAll, selected, allLabel, select],
  );

  return <LocationContext.Provider value={value}>{children}</LocationContext.Provider>;
}
