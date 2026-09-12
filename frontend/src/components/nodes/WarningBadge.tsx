import type { ValidationStatus } from '../../types/graph';
import { getValidationStatusColor, getValidationStatusLabel, hasValidationDot } from '../../utils/validationStatus';

export default function WarningBadge({
  status = 'error',
  size = 14,
}: {
  status?: ValidationStatus;
  size?: number;
}) {
  // No findings = no dot. Absence is the "all clear" signal; a green dot
  // could not distinguish clean from never-validated.
  if (!hasValidationDot(status)) return null;
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
    />
  );
}