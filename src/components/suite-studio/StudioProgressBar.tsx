export interface StudioProgressStep {
  key: string;
  index: string;
  label: string;
  state: "done" | "active" | "pending" | "failed";
  alignEnd?: boolean;
}

interface Props {
  headline: string;
  percent: number;
  progressLabel: string;
  stepsLabel?: string;
  steps: StudioProgressStep[];
}

export function StudioProgressBar({ headline, percent, progressLabel, stepsLabel, steps }: Props) {
  const value = Number.isNaN(percent) ? 0 : Math.max(0, Math.min(100, percent));
  return (
    <div className="ss-progress">
      <div className="ss-progress-head">
        <strong>{headline}</strong>
        <span className="ss-progress-pct">{value}%</span>
      </div>
      <div
        className="ss-progress-track"
        role="progressbar"
        aria-label={progressLabel}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
        aria-valuetext={`${value}% · ${headline}`}
      >
        <div className="ss-progress-fill" style={{ width: `${value}%` }} />
      </div>
      <ol className="ss-progress-steps" aria-label={stepsLabel}>
        {steps.map((step) => (
          <li key={step.key} className={step.alignEnd ? "ss-step ss-step-copy" : "ss-step"} data-step-state={step.state}>
            <span className="ss-step-badge" aria-hidden="true">{step.state === "done" ? "✓" : step.index}</span>
            <span>{step.label}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
