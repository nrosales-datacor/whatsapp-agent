// API pública del módulo scheduling: lo único que otros módulos (y la composición en src/)
// pueden importar de acá (test/architecture/moduleBoundaries.test.ts). Disponibilidad y
// reserva son UN solo servicio para el panel y el agente de WhatsApp (I2).
export {
  APPOINTMENT_TRANSITIONS,
  bookAppointment,
  cancelAppointment,
  canTransition,
  completeAppointment,
  confirmAppointment,
  getAppointment,
  listAppointments,
  listClientAppointments,
  listUpcomingAppointmentsForClient,
  markNoShow,
  reassignStaff,
  rescheduleAppointment,
  updateAppointmentNotes,
} from "./appointments";
export type {
  AppointmentLineView,
  AppointmentView,
  BookAppointmentInput,
  ClientHistoryPage,
  ListAppointmentsFilter,
  MoveInput,
} from "./appointments";
export { bookingMinLeadMin, DEFAULT_SLOT_INTERVAL_MIN, findSlots, MAX_SERVICES_PER_APPOINTMENT } from "./availability";
export type { FindSlotsInput, Slot, SlotStaff } from "./availability";
export { getHomeToday, type HomeToday } from "./home";
export {
  handleReminderJob,
  REMINDER_SEND_JOB,
  startReminderScheduler,
  sweepDueReminders,
  type ReminderJobDeps,
  type ReminderJobPayload,
  type ReminderOutcome,
} from "./reminders";
export { schedulingRoutes, type SchedulingRouteDeps } from "./routes";
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
