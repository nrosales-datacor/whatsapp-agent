// Placeholder del scaffold (paso A1). Confirma que el build de React se sirve
// desde el server bajo /panel. Las pantallas reales (login, bandeja, ficha,
// dashboard) se migran en A2–A5 reusando la API /api/panel/* existente.
export default function App() {
  return (
    <main className="shell">
      <div className="card">
        <div className="brand">
          <span className="brand-chip" aria-hidden="true">
            ◆
          </span>
          <span className="brand-txt">Panel</span>
        </div>
        <h1>Panel en React</h1>
        <p>
          El nuevo panel (React&nbsp;+&nbsp;TypeScript) ya se sirve desde el servidor. Las pantallas
          —&nbsp;bandeja, ficha de cliente y dashboard&nbsp;— se migran en los próximos pasos,
          reusando la misma API.
        </p>
        <p className="muted">Paso A1 · scaffold listo ✓</p>
      </div>
    </main>
  );
}
