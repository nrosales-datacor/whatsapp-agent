// Paso A2 — preview ESTÁTICO del Login, con el markup real del panel, para verificar
// que el sistema de diseño (global.css, portado de inbox.html) luce idéntico.
// Todavía no tiene lógica: el envío y el manejo de sesión se cablean en A4.
export default function App() {
  return (
    <div id="login">
      <form id="loginForm" onSubmit={(e) => e.preventDefault()}>
        <div className="marca">
          <span className="marca-chip" aria-hidden="true">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M4 13h4l2 3h4l2-3h4" />
              <path d="M5 6h14a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1Z" />
            </svg>
          </span>
          <span className="marca-txt">Panel de atención</span>
        </div>
        <h1>Bandeja</h1>
        <p>Ingresá para responder a tus clientes y ver las métricas de tu negocio.</p>
        <label htmlFor="usuario">Negocio</label>
        <input id="usuario" autoComplete="username" placeholder="ej: lavacar-rosales" required />
        <label htmlFor="password">Contraseña</label>
        <input id="password" type="password" autoComplete="current-password" required />
        <button type="submit">Entrar</button>
        <div id="loginError"></div>
      </form>
    </div>
  );
}
