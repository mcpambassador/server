interface SparklineProps {
  data: number[];
  width?: number;
  height?: number;
  className?: string;
}

/**
 * Pure SVG sparkline — no external dependencies.
 * Renders a 200x40 polyline chart with subtle grid lines and min/max labels.
 */
export function Sparkline({ data, width = 200, height = 40, className }: SparklineProps) {
  if (data.length === 0) {
    return (
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className={className}
        aria-label="No data"
      >
        <line
          x1="0"
          y1={height / 2}
          x2={width}
          y2={height / 2}
          stroke="currentColor"
          strokeWidth="1"
          strokeDasharray="4 4"
          className="text-zinc-300 dark:text-zinc-700"
        />
      </svg>
    );
  }

  const padding = { top: 6, bottom: 14, left: 4, right: 4 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;

  // Map data points to SVG coordinates
  const points = data.map((value, index) => {
    const x = padding.left + (index / Math.max(data.length - 1, 1)) * chartWidth;
    const y = padding.top + chartHeight - ((value - min) / range) * chartHeight;
    return { x, y, value };
  });

  const polylinePoints = points.map(p => `${p.x},${p.y}`).join(' ');

  // Grid lines at 0%, 50%, 100% of chart height
  const gridYPositions = [
    padding.top,
    padding.top + chartHeight / 2,
    padding.top + chartHeight,
  ];

  const minLabel = min.toLocaleString();
  const maxLabel = max.toLocaleString();

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      aria-label={`Sparkline chart, range ${minLabel} to ${maxLabel}`}
    >
      {/* Grid lines */}
      {gridYPositions.map((y, i) => (
        <line
          key={i}
          x1={padding.left}
          y1={y}
          x2={width - padding.right}
          y2={y}
          stroke="currentColor"
          strokeWidth="0.5"
          className="text-zinc-200 dark:text-zinc-700"
        />
      ))}

      {/* Fill area under the line */}
      <polyline
        points={[
          `${points[0].x},${padding.top + chartHeight}`,
          ...points.map(p => `${p.x},${p.y}`),
          `${points[points.length - 1].x},${padding.top + chartHeight}`,
        ].join(' ')}
        fill="currentColor"
        className="text-blue-100 dark:text-blue-900/40"
        opacity="0.6"
      />

      {/* Trend line */}
      <polyline
        points={polylinePoints}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
        className="text-blue-500 dark:text-blue-400"
      />

      {/* Min label (bottom-left) */}
      <text
        x={padding.left}
        y={height}
        fontSize="8"
        fill="currentColor"
        className="text-zinc-400 dark:text-zinc-500"
      >
        {minLabel}
      </text>

      {/* Max label (top-right) */}
      <text
        x={width - padding.right}
        y={10}
        fontSize="8"
        fill="currentColor"
        textAnchor="end"
        className="text-zinc-400 dark:text-zinc-500"
      >
        {maxLabel}
      </text>
    </svg>
  );
}
