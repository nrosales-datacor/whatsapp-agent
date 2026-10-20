// Configuración de PM2 para el servidor (DEPLOY.md §6).
//
// Lo que aporta: `kill_timeout`. En un `pm2 reload`/`restart`, PM2 manda SIGINT y, si el
// proceso no terminó en ese tiempo, SIGKILL. El server se apaga ordenado
// (src/platform/net/shutdown.ts): deja de aceptar requests y de reclamar jobs y espera a
// que terminen las tareas en curso (hasta SHUTDOWN_GRACE_MS, default 25 s). Con el default
// de PM2 (1,6 s) una tarea a mitad de una llamada externa se cortaba y el reaper la
// repetía minutos después (respuesta duplicada o tardía).
//
// Un solo proceso con `ROLE=all` (default). Para separar web y worker, duplicar la app
// con `env: { ROLE: "web" }` y `env: { ROLE: "worker" }` (y otro PORT para el worker).
//
// Primera vez en el servidor:  pm2 start ecosystem.config.cjs && pm2 save
module.exports = {
  apps: [
    {
      name: "selyon-crm",
      script: "src/server.ts",
      interpreter: "node",
      node_args: "--import tsx",
      cwd: __dirname,
      // Un poco más que SHUTDOWN_GRACE_MS: el server sale solo antes de que llegue el SIGKILL.
      kill_timeout: 30_000,
      // Reinicia si el proceso muere; con backoff para no martillar ante un fallo al arrancar.
      autorestart: true,
      exp_backoff_restart_delay: 200,
      env: { NODE_ENV: "production", ROLE: "all" },
    },
  ],
};
