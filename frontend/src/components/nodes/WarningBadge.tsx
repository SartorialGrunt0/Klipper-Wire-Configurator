import type { ValidationStatus } from '../../types/graph';
import { getValidationStatusColor, getValidationStatusLabel } from '../../utils/validationStatus';

export default function WarningBadge({
  status = 'error',
  size = 14,
}: {
  status?: ValidationStatus;
  size?: number;
}) {
  return (
    <span
      className="kwc-warning-badge"
      aria-label={getValidationStatusLabel(status)}
      title={getValidationStatusLabel(status)}
      style={{
        width: size,
        height: size,
        backgroundColor: getValidationStatusColor(status),
      }}
    >
      <span className="kwc-warning-badge-icon" aria-hidden="true" />
    </span>
  );
}