export default function Sparkline({ data, width = 320, height = 72 }) {
  if (!data || data.length < 2) {
    return <p className="empty">Not enough score history to chart yet (the subgraph records ScoreUpdated events).</p>;
  }

  const points = data.slice().reverse();
  const min = Math.min(...points.map((point) => Number(point.newScore)), 0);
  const max = Math.max(...points.map((point) => Number(point.newScore)), 1000);
  const range = max - min || 1;
  const step = width / (points.length - 1);
  const y = (value) => (height - 8 - ((value - min) / range) * (height - 16)).toFixed(1);
  const coords = points.map((point, index) => `${(index * step).toFixed(1)},${y(point.newScore)}`);

  return (
    <svg width="100%" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Score over time">
      <polyline points={coords.join(" ")} fill="none" stroke="var(--sky)" strokeWidth="2" />
      {points.map((point, index) => (
        <circle key={index} cx={(index * step).toFixed(1)} cy={y(point.newScore)} r="2.5" fill="var(--acid)" />
      ))}
      <text x="0" y={height - 2} fill="var(--ink-muted)" fontSize="9" fontFamily="monospace">{points[0].newScore}</text>
      <text x={width - 24} y={height - 2} fill="var(--ink-muted)" fontSize="9" fontFamily="monospace">{points[points.length - 1].newScore}</text>
    </svg>
  );
}
