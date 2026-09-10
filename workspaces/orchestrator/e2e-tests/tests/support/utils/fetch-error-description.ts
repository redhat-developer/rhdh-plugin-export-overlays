export function describeFetchError(err: unknown): string {
  if (!(err instanceof Error)) {
    return String(err);
  }

  const cause = err.cause;
  if (!(cause instanceof Error)) {
    return err.message;
  }

  const detail =
    cause.message ||
    (cause instanceof AggregateError ? cause.errors[0]?.message : "") ||
    (cause as NodeJS.ErrnoException).code;
  return detail ? `${err.message} (${detail})` : err.message;
}
