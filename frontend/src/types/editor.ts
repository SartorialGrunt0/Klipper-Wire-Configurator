import type { ConfigSection, ValidationError } from './config';

/**
 * One finding as the text view renders it: the backend finding (severity,
 * message, section/param) plus the *resolved* line and the acknowledgement
 * identity the row needs to offer an "Acknowledge" button.
 *
 * `line` is 0 for file-level findings (no line to jump to or colour).
 */
export interface TextIssue {
  line: number;
  text: string;
  severity: ValidationError['severity'];
  section?: string;
  param?: string;
  acknowledgeSection?: ConfigSection;
  acknowledgeKind?: 'unknown' | 'duplicate' | 'registry';
  /** Registry acks need the finding identity (code + command name), not
   *  the section: one ack per command, mirroring the server's identity
   *  granularity. */
  acknowledgeCode?: string;
  acknowledgeExtra?: string;
}
