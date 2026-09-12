export function SectionLabel({ children }) {
  return <span className="panel-index">{children}</span>;
}

export function Panel({ children, className = "" }) {
  return <section className={`panel ${className}`.trim()}>{children}</section>;
}

export function StatusPill({ children, tone = "live" }) {
  return <span className={`status-pill ${tone}`}>{children}</span>;
}
