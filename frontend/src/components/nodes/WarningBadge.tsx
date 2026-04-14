export default function WarningBadge() {
  return (
    <span
      className="kwc-warning-badge"
      aria-label="Validation error"
      title="This card contains invalid values"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true" className="kwc-warning-badge-icon">
        <path d="M12 3 2 21h20L12 3Zm0 5.5a1 1 0 0 1 1 1V14a1 1 0 0 1-2 0V9.5a1 1 0 0 1 1-1Zm0 9a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5Z" fill="currentColor" />
      </svg>
    </span>
  );
}