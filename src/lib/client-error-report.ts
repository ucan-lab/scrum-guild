// 画面で捕まえていない例外と Promise の拒否を、POST /api/client-errors へ送る（Issue #376）
import type { ClientErrorReport } from '../shared/client-error.ts';

export type ClientErrorReporterOptions = {
  send: (report: ClientErrorReport) => void | Promise<void>;
  version: string;
  routeId: () => string | null;
  origin: string;
};

export type ClientErrorReporter = {
  onError(event: ErrorEvent): void;
  onRejection(event: PromiseRejectionEvent): void;
};

export function createClientErrorReporter(_options: ClientErrorReporterOptions): ClientErrorReporter {
  throw new Error('未実装');
}

export function installClientErrorReporter(_routeId: () => string | null): () => void {
  throw new Error('未実装');
}
