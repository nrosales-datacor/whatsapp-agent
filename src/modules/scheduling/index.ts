// API pública del módulo scheduling: lo único que otros módulos pueden importar de acá
// (test/architecture/moduleBoundaries.test.ts). Por ahora, tipos; crece en I1.
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
