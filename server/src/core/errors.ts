/** Коды ошибок домена, которые транслируются в HTTP-статусы и MCP-ответы. */
export type TrackerErrorCode =
  | 'TASK_NOT_FOUND'
  | 'QUESTION_NOT_FOUND'
  | 'TAG_NOT_FOUND'
  | 'LINK_NOT_FOUND'
  | 'VALIDATION_FAILED'
  | 'INVALID_TRANSITION'
  | 'STATUS_REQUIRES_USER'
  | 'CONFLICT'
  | 'INTERNAL';

const HTTP_STATUS_BY_CODE: Record<TrackerErrorCode, number> = {
  TASK_NOT_FOUND: 404,
  QUESTION_NOT_FOUND: 404,
  TAG_NOT_FOUND: 404,
  LINK_NOT_FOUND: 404,
  VALIDATION_FAILED: 400,
  INVALID_TRANSITION: 409,
  STATUS_REQUIRES_USER: 403,
  CONFLICT: 409,
  INTERNAL: 500,
};

export class TrackerError extends Error {
  public readonly code: TrackerErrorCode;
  public readonly details: Record<string, unknown>;

  public constructor(code: TrackerErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'TrackerError';
    this.code = code;
    this.details = details;
  }

  public get httpStatus(): number {
    return HTTP_STATUS_BY_CODE[this.code];
  }

  public toJSON(): { code: TrackerErrorCode; message: string; details: Record<string, unknown> } {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export function isTrackerError(error: unknown): error is TrackerError {
  return error instanceof TrackerError;
}
