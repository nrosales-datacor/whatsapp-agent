# Proceso de cobro manual (Carril D, 0.6)

> Documento operativo, sin código. Cubre cómo se cobra a los negocios mientras no existe
> facturación automática (Stripe, **C4.3**, sigue pendiente). Reemplaza este proceso cuando C4.3
> quede cableado — hasta entonces, esto es lo único que hay entre "el cliente paga" y "el bot le
> sigue funcionando".

**Última actualización:** 2026-10-01

---

## 1. Ciclo de facturación

- **Corte mensual por fecha de alta**, no por fecha calendario: cada negocio se cobra cada 30 días
  desde el día en que se dio de alta en `/panel/admin` (columna `id`/fecha de creación del tenant).
  Evita tener que sincronizar todos los negocios al día 1.
- **Período de prueba:** si se ofrece trial al vender, definirlo en días antes del primer cobro
  (ej. 15 días) y anotarlo en la hoja de seguimiento (§4). Hoy no hay campo de trial en el admin
  (`estadoFacturacion` existe en el schema pero no se expone todavía) — se controla a mano.
- **Precio vigente:**
  - Básico: ₡35.000/mes
  - Pro: ₡60.000/mes
  - Precio fundador (descuento a los primeros clientes): **pendiente de definir** — ver checklist
    de arranque en `PLAN-FEATURES-FALTANTES.md`. No cobrar un descuento que no esté escrito acá.

## 2. Medio de pago

- **SINPE Móvil o transferencia bancaria** al número/cuenta de Selyon — no hay pasarela todavía.
- El comprobante lo manda el dueño por WhatsApp (captura del SINPE) al número de cobro (no al
  número del bot del cliente — no mezclar canales).
- Legal/factura electrónica ante Hacienda: **[PENDIENTE-NATHAN]** — definir si Selyon ya está
  inscrito para emitir factura electrónica o si por ahora se manda un recibo simple (ver plantilla
  abajo). No prometerle "factura" formal al cliente hasta resolver esto.

## 3. Plantilla de recibo/comprobante

Texto simple por WhatsApp o PDF liviano, uno por cobro. Copiar y completar:

```
Recibo de pago — Selyon
Negocio: {nombre del negocio}
Plan: {Básico ₡35.000 / Pro ₡60.000}
Período: {dd/mm/yyyy} — {dd/mm/yyyy}
Monto: ₡{monto}
Medio: SINPE Móvil / Transferencia
Fecha de pago: {dd/mm/yyyy}
Recibido por: {nombre}
```

Sin factura electrónica todavía ([PENDIENTE-NATHAN] arriba), este recibo es el único comprobante
que se le entrega al dueño — guardarlo (carpeta compartida o el mismo chat) para tener respaldo.

## 4. Recordatorio de pago por WhatsApp al dueño

Enviar al **número personal del dueño** (no al número del bot), en tres momentos:

- **3 días antes del corte** (aviso, no reclamo):
  > Hola {nombre}, te recuerdo que el {fecha} vence tu suscripción de Selyon ({plan}, ₡{monto}).
  > Cuando puedas hacer el SINPE me confirmás con la captura. ¡Gracias!

- **Día del corte, si no hay pago:**
  > Hola {nombre}, no me llegó el comprobante del pago de este mes de Selyon. ¿Podés confirmarme
  > si ya lo hiciste o necesitás unos días más?

- **Fin del período de gracia, si sigue sin pago** (ver §5):
  > Hola {nombre}, como no recibí el pago voy a tener que pausar temporalmente el bot de WhatsApp
  > hasta ponernos al día. En cuanto me confirmés el pago lo reactivo enseguida.

## 5. Política de gracia y qué pasa si no paga

| Día | Acción |
|---|---|
| Corte (día 0) | Recordatorio de "día del corte" (§4). Servicio sigue igual. |
| Día 0–5 (gracia) | Sin acción sobre el producto. Solo seguimiento humano. |
| Día 5 | Si el negocio es **Pro** y no pagó, bajarlo a **Básico** desde `/panel/admin` (columna Plan,
sin redeploy) — pierde Campañas/features Pro pero el bot sigue atendiendo. Es la palanca que ya
existe hoy (Carril D, 0.1). |
| Día 10 | Si sigue sin pago, **pausar el bot por completo**: en `/panel/admin`, fila del negocio →
botón **"Pausar"** (pide confirmación y un motivo opcional, ej. "falta de pago septiembre"). Efecto
inmediato, sin redeploy: el bot deja de responder a ese número (los mensajes que lleguen **se
siguen guardando** en el chat, el dueño los ve al reactivar), no salen recordatorios, campañas ni
rescates, y el dueño ve en su panel "Tu cuenta está pausada. Contactá a Selyon". No se borra
ningún dato. Queda registrado quién pausó, cuándo y por qué (botón "Historial" del negocio). |
| Al pagar | En `/panel/admin` → botón **"Reactivar"** del negocio (si se pausó) + volver el plan a
Pro desde la columna Plan (si se había bajado). Confirmar por WhatsApp que ya está reactivado. |

No se corta nunca a mitad de una conversación activa con un cliente final — el corte es a nivel de
negocio completo, y el dueño recibe el aviso del día 0 y del día 10 antes de que pase.

## 6. Checklist mensual (15 min, usando el admin de 0.1)

1. Entrar a `/panel/admin` → tabla de negocios.
2. Por cada negocio, anotar en la hoja de seguimiento: nombre, plan actual, fecha de corte,
   ¿pagó este mes? (revisar comprobantes recibidos por WhatsApp).
3. Columna **"Conversaciones este mes"** del admin: comparar contra el tope aproximado del plan
   (Básico ~500/mes, sin bloqueo todavía — Carril D, 0.2) y contra lo que factura Meta Business
   Manager, para detectar desvíos grandes (±5%).
4. Para los que están atrasados según §5, mandar el recordatorio que corresponda (§4) y aplicar la
   acción del día que toque (bajar plan / pausar con el botón "Pausar"). Los pausados aparecen en la
   misma tabla marcados como **Pausado**, con la fecha y el motivo.
5. Actualizar la hoja de seguimiento con el resultado (pagó / bajado a Básico / pausado).

## Nota

Este documento se reemplaza cuando **C4.3 (Stripe)** quede cableado end-to-end (checkout,
webhook de estado, portal de cliente) — en ese punto el cobro, el recordatorio y la suspensión por
atraso los maneja Stripe + `estadoFacturacion`, y este proceso manual pasa a ser el plan B si
Stripe falla.
