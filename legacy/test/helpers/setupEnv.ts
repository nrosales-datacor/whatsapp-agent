// Se importa ANTES que cualquier módulo del server. Fija credenciales dummy para
// que los módulos que construyen su cliente de OpenAI en el load (p. ej.
// src/whatsapp/transcribir.ts) no revienten por falta de OPENAI_API_KEY. En los
// tests la red está mockeada (ver webhookMock.ts), así que la key nunca se usa.
if (!process.env.OPENAI_API_KEY) process.env.OPENAI_API_KEY = "sk-test";
