/* eslint-disable */
// ICED26 — admin mockup screens (no real backend)

const { useState: useStateA } = React;

function AdminPanel({ open, onClose, data, lang }) {
  const [tab, setTab] = useStateA("upload");
  if (!open) return null;
  const isES = lang === "es";

  return (
    <div className="admin-overlay" role="dialog" aria-modal="true" aria-label="Admin panel">
      <div className="admin-modal">
        <div className="admin-head">
          <div>
            <h2>{isES ? "Panel de administración" : "Admin panel"}</h2>
            <div className="head-meta">{isES ? "Acceso solo organizadores · sin login" : "Organizers only · no login"}</div>
          </div>
          <button className="close-btn" onClick={onClose} aria-label="Close">✕ {isES ? "Cerrar" : "Close"}</button>
        </div>
        <div className="admin-tabs">
          <button className={`admin-tab ${tab === "upload" ? "active" : ""}`} onClick={() => setTab("upload")}>
            {isES ? "Programa (Excel)" : "Programme (Excel)"}
          </button>
          <button className={`admin-tab ${tab === "rooms" ? "active" : ""}`} onClick={() => setTab("rooms")}>
            {isES ? "Salas y Meet" : "Rooms & Meet"}
          </button>
          <button className={`admin-tab ${tab === "config" ? "active" : ""}`} onClick={() => setTab("config")}>
            {isES ? "Configuración" : "Configuration"}
          </button>
        </div>
        <div className="admin-body">
          {tab === "upload" && <UploadTab data={data} isES={isES} />}
          {tab === "rooms" && <RoomsTab data={data} isES={isES} />}
          {tab === "config" && <ConfigTab data={data} isES={isES} />}
        </div>
      </div>
    </div>
  );
}

function UploadTab({ data, isES }) {
  const [stage, setStage] = useStateA("idle"); // idle | preview
  const sample = data.sessions.slice(0, 8);

  return (
    <>
      <div className="upload-zone">
        <div className="uz-icon">⬆</div>
        <h3>{isES ? "Subir programa (.xlsx)" : "Upload programme (.xlsx)"}</h3>
        <p>{isES ? "Una hoja · cabeceras: Día, Hora inicio, Hora fin, Sala, Título, Ponente(s), Tipo" : "Single sheet · headers: Day, Start, End, Room, Title, Speakers, Type"}</p>
        <p className="muted">{isES ? "Cada subida reemplaza el programa actual." : "Each upload replaces the current programme."}</p>
        <button onClick={() => setStage("preview")}>{isES ? "Seleccionar archivo…" : "Choose file…"}</button>
      </div>

      {stage === "preview" && (
        <>
          <div className="warn-banner">
            <strong>⚠ {isES ? "Validación: 1 advertencia, 0 errores" : "Validation: 1 warning, 0 errors"}.</strong>{" "}
            {isES ? "Revisa antes de confirmar — al confirmar se reemplaza el programa entero." : "Review before confirming — confirming will replace the whole programme."}
          </div>
          <div style={{maxHeight: 280, overflow: "auto", border: "1px solid var(--line)", borderRadius: 8}}>
            <table className="preview-table">
              <thead>
                <tr>
                  <th>{isES ? "Día" : "Day"}</th>
                  <th>{isES ? "Inicio" : "Start"}</th>
                  <th>{isES ? "Fin" : "End"}</th>
                  <th>{isES ? "Sala" : "Room"}</th>
                  <th>{isES ? "Título" : "Title"}</th>
                  <th>{isES ? "Ponente(s)" : "Speakers"}</th>
                  <th>{isES ? "Tipo" : "Type"}</th>
                </tr>
              </thead>
              <tbody>
                {sample.map((s, i) => (
                  <tr key={i} className={i === 5 ? "has-error" : ""}>
                    <td>{s.day}</td>
                    <td>{s.start}</td>
                    <td>{s.end}</td>
                    <td>{s.room === "*" ? "*" : (s.roomName || data.rooms.find(r => r.id === s.room)?.name)}</td>
                    <td>
                      {s.title}
                      {i === 5 && <div className="err-msg">⚠ {isES ? "Sala desconocida — se creará nueva (sin Meet asignado)" : "Unknown room — will create new (no Meet assigned)"}</div>}
                    </td>
                    <td>{(s.talks && s.talks[0]?.presenter) || s.speakers || "—"}</td>
                    <td>{s.type}</td>
                  </tr>
                ))}
                <tr><td colSpan="7" className="muted" style={{textAlign:"center"}}>+{data.sessions.length - 8} {isES ? "filas más…" : "more rows…"}</td></tr>
              </tbody>
            </table>
          </div>
          <div className="preview-actions">
            <button className="btn-secondary" onClick={() => setStage("idle")}>{isES ? "Cancelar" : "Cancel"}</button>
            <button className="btn-danger">{isES ? "Confirmar y reemplazar programa" : "Confirm & replace programme"}</button>
          </div>
        </>
      )}
    </>
  );
}

function RoomsTab({ data, isES }) {
  return (
    <>
      <p className="muted" style={{marginBottom: 16}}>
        {isES ? "Las salas se identifican por su nombre tal cual aparece en el Excel. Pega aquí la URL de Meet permanente de cada sala." : "Rooms are identified by their name in the Excel. Paste each room's permanent Meet URL here."}
      </p>
      {data.rooms.map(r => (
        <div className="room-row" key={r.id}>
          <div className="rr-name">{r.name}</div>
          <input type="url" defaultValue={r.meet} placeholder="https://meet.google.com/..." />
          <span className={`rr-status ${r.meet ? "rr-ok" : "rr-empty"}`}>{r.meet ? (isES ? "✓ Conectado" : "✓ Linked") : (isES ? "Vacío" : "Empty")}</span>
        </div>
      ))}
      <div className="preview-actions">
        <button className="btn-primary">{isES ? "Guardar cambios" : "Save changes"}</button>
      </div>
    </>
  );
}

function ConfigTab({ data, isES }) {
  return (
    <>
      <div className="config-section">
        <h3>{isES ? "URL pública (slug)" : "Public URL (slug)"}</h3>
        <div className="desc">
          {isES ? "URL secreta repartida por EasyChair. Si la regeneras, la anterior deja de funcionar." : "Secret URL shared via EasyChair. Regenerating invalidates the previous one."}
        </div>
        <div className="slug-display">
          <span style={{color:"var(--ink-mute)"}}>https://iced26-live.es</span>
          <span style={{fontWeight:600}}>/c/k2j8h4l6mz9p3q5r7t8v0w2x4y6a</span>
          <button className="btn-secondary" style={{marginLeft:"auto"}}>↻ {isES ? "Regenerar" : "Regenerate"}</button>
        </div>
      </div>

      <div className="config-section">
        <h3>{isES ? "Fechas del congreso" : "Conference dates"}</h3>
        <div className="desc">{isES ? "Tres días. La interfaz mostrará una pestaña por día." : "Three days. The UI shows one tab per day."}</div>
        <div style={{display:"flex", gap: 12}}>
          {data.meta.days.map((d, i) => (
            <div key={i} style={{padding:"10px 14px", background:"var(--cream)", border:"1px solid var(--line)", borderRadius:8, fontSize:13, fontVariantNumeric:"tabular-nums"}}>
              <div style={{fontSize:11, color:"var(--ink-mute)", letterSpacing:"0.06em"}}>{["DAY 1","DAY 2","DAY 3"][i]}</div>
              {d}
            </div>
          ))}
        </div>
      </div>

      <div className="config-section" style={{borderBottom:"none"}}>
        <h3>{isES ? "Zona horaria" : "Timezone"}</h3>
        <div className="desc">{isES ? "Se usa para calcular el estado de cada sesión (pasada/en vivo/próxima) independientemente del navegador." : "Used to compute past/live/future regardless of the visitor's browser."}</div>
        <div style={{display:"inline-block", padding:"8px 14px", background:"var(--cream)", border:"1px solid var(--line)", borderRadius:8, fontFamily:"ui-monospace, monospace", fontSize: 13}}>
          {data.meta.timezone}
        </div>
      </div>

      <div className="preview-actions">
        <button className="btn-primary">{isES ? "Guardar configuración" : "Save configuration"}</button>
      </div>
    </>
  );
}

window.ICED26Admin = { AdminPanel };
