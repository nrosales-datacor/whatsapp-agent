// API pública del módulo scheduling: lo único que otros módulos (y la composición en src/)
// pueden importar de acá (test/architecture/moduleBoundaries.test.ts). Disponibilidad y
// reserva son UN solo servicio para el panel y el agente de WhatsApp (I2).
export {
  addServiceToAppointment,
  APPOINTMENT_TRANSITIONS,
  bookAppointment,
  cancelAppointment,
  canTransition,
  clientIdsWithStaffAppointments,
  completeAppointment,
  confirmAppointment,
  getAppointment,
  getAppointmentsByIds,
  listAppointments,
  listClientAppointments,
  listUpcomingAppointmentsForClient,
  markNoShow,
  reassignStaff,
  rescheduleAppointment,
  updateAppointmentDetails,
  updateAppointmentNotes,
} from "./appointments";
export type {
  AppointmentBookedHook,
  AppointmentCompletedHook,
  AppointmentDetailsPatch,
  AppointmentLineView,
  AppointmentView,
  BookAppointmentInput,
  ClientHistoryPage,
  ListAppointmentsFilter,
  MoveInput,
} from "./appointments";
export { bookingMinLeadMin, DEFAULT_SLOT_INTERVAL_MIN, findSlots, MAX_SERVICES_PER_APPOINTMENT } from "./availability";
export type { FindSlotsInput, Slot, SlotStaff } from "./availability";
export { countBookingsByChannel, nextAppointmentsForClients } from "./channelStats";
// Agregados en SQL para Reportes e Inicio completo (I5) y el reparto de montos por cita que usa sales.
export {
  attributeAmounts,
  CHANNEL_LABELS,
  getAppointmentBreakdown,
  getBookedMinutesByStaff,
  getClientVisitStats,
  getServiceLineStats,
} from "./stats";
export type {
  AmountsSubquery,
  AppointmentBreakdown,
  AppointmentCounts,
  AppointmentGroup,
  AppointmentGroupBy,
  Attribution,
  AttributedGroup,
  AttributionInput,
  AttributionKey,
  ClientVisitStats,
  ServiceLineStats,
  StatsRange,
} from "./stats";
export { getHomeToday, type ConversationsWaitingCounter, type HomeToday } from "./home";
export {
  handleReminderJob,
  recordReminderDeliveryFailure,
  REMINDER_SEND_JOB,
  startReminderScheduler,
  sweepDueReminders,
  type ReminderJobDeps,
  type ReminderJobPayload,
  type ReminderOutcome,
  type WhatsAppReminderRequest,
} from "./reminders";
export { schedulingRoutes, type SchedulingRouteDeps } from "./routes";
// Segmentos y resultados de Campañas (I6): subconsultas de clientes y citas generadas.
export {
  clientIdsLapsedForService,
  clientIdsWithUpcomingAppointments,
  countAppointmentsAfterSends,
  listCompletedAppointmentsEndedBetween,
  type AppointmentsAfterSends,
  type CompletedAppointmentRef,
} from "./segments";
// Fechas en la zona de una sucursal (bandeja, métricas y recordatorios de otros módulos).
export { addDays, isLocalDate, localDate, localDatesBetween, localDayBounds, mondayOf, wallClock } from "./time";
export { APPOINTMENT_CHANNELS, APPOINTMENT_STATUSES } from "./schema";
export type {
  Appointment,
  AppointmentChannel,
  AppointmentService,
  AppointmentStatus,
  NewAppointment,
  NewAppointmentService,
  NewReminder,
  Reminder,
  ReminderDeliveryChannel,
  ReminderKind,
  ReminderStatus,
} from "./schema";
