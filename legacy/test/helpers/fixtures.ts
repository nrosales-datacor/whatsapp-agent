import type { Bloqueo, Cita, Empleado, HorarioDia, Service, Tenant } from "../../src/types";

// ─────────────────────────────────────────────────────────────────────────────
// Fabricadores para tests: un Tenant "de lavacar" razonable por defecto, con
// overrides puntuales por test. Evita repetir el objeto completo en cada caso.
// ─────────────────────────────────────────────────────────────────────────────

const HORARIO_LUNES_A_SABADO: Record<number, HorarioDia> = {
  0: { abre: null, cierra: null }, // domingo cerrado
  1: { abre: "07:00", cierra: "17:00" },
  2: { abre: "07:00", cierra: "17:00" },
  3: { abre: "07:00", cierra: "17:00" },
  4: { abre: "07:00", cierra: "17:00" },
  5: { abre: "07:00", cierra: "17:00" },
  6: { abre: "07:00", cierra: "13:00" },
};

const SERVICIOS_DEFAULT: Service[] = [
  { id: "lavado-basico", nombre: "Lavado básico", precio: 5000, duracionMin: 30, agendable: true },
  { id: "pulido", nombre: "Pulido", precio: 25000, duracionMin: 90, agendable: true },
];

export function crearTenant(overrides: Partial<Tenant> = {}): Tenant {
  return {
    id: "tenant-1",
    nombre: "Lavacar Rosales",
    phoneNumberId: "1234567890",
    timezone: "America/Costa_Rica",
    moneda: "CRC",
    ubicacion: "San José",
    horario: HORARIO_LUNES_A_SABADO,
    intervaloAgendaMin: 30,
    servicios: SERVICIOS_DEFAULT,
    kb: { faq: [], datos: [], politicas: [] },
    bloqueos: [] as Bloqueo[],
    // Sin equipo cargado = modo recurso único (comportamiento previo a ALTO-07). Los
    // tests que prueban capacidad simultánea pasan sus propios empleados por override.
    empleados: [] as Empleado[],
    plan: "basico",
    ...overrides,
  };
}

export function crearCita(overrides: Partial<Cita> = {}): Cita {
  return {
    id: "cita-1",
    tenantId: "tenant-1",
    clienteWa: "50688887777",
    clienteNombre: "Cliente de prueba",
    servicioId: "lavado-basico",
    fecha: "2026-07-20",
    hora: "09:00",
    estado: "agendada",
    creadaEn: "2026-07-14T12:00:00.000Z",
    ...overrides,
  };
}
