/** Queue contract between reports-api and report-worker. Keep both copies in sync. */
export const SUBJECT_REQUESTED = 'reports.requested';
export const SUBJECT_STATUS = 'reports.status';

export interface ReportRequested {
  reportId: string;
  userId: string;
  /** From the token's `email` claim: whoever the identity provider says the user is. */
  email: string;
  /** YYYY-MM */
  period: string;
  /** Demo switch: the worker fails its first attempt so you can watch the redelivery. */
  crashFirstAttempt: boolean;
}

export interface ReportStatus {
  reportId: string;
  status: 'processing' | 'retrying' | 'sent' | 'failed';
  attempt: number;
  rows?: number;
  sentTo?: string;
  error?: string;
  at: string;
}
