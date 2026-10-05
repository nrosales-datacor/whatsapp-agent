// Configuración de PM2 para el droplet (DEPLOY.md §6). Reemplaza el `pm2 start npm --name
// whatsapp-bot -- start` a mano: mismo nombre de app, así el pipeline (`pm2 reload
// whatsapp-bot`) no cambia.
//
// Lo que aporta: `kill_timeout`. En un `pm2 reload`/`restart`, PM2 manda SIGINT y, si el
// proceso no terminó en ese tiempo, SIGKILL. El server se apaga ordenado (src/red/apagado.ts):
// deja de aceptar requests y de reclamar jobs y espera a que terminen los turnos del agente
// en curso (hasta APAGADO_ESPERA_MS, default 25 s). Con el default de PM2 (1,6 s) un turno
// a mitad de la llamada al LLM se cortaba y el reaper lo repetía minutos después (respuesta
// duplicada o tardía).
//
// Migración, una sola vez en el droplet:
//   pm2 delete whatsapp-bot && pm2 start ecosystem.config.cjs && pm2 save
module.exports = {
  apps: [
    {
      name: "whatsapp-bot",
      script: "src/server.ts",
      interpreter: "node",
      node_args: "--import tsx",
      cwd: __dirname,
      // Un poco más que APAGADO_ESPERA_MS: el server sale solo antes de que llegue el SIGKILL.
      kill_timeout: 30_000,
      // Reinicia si el proceso muere; con backoff para no martillar ante un fallo al arrancar.
      autorestart: true,
      exp_backoff_restart_delay: 200,
      env: { NODE_ENV: "production" },
    },
  ],
};
