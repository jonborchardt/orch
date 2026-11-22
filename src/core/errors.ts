/** Errors carry the CLI exit code so handlers stay thin. */
export class OrchError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode: number) {
    super(message);
    this.exitCode = exitCode;
    this.name = new.target.name;
  }
}

/** Bad command line: unknown command, missing or malformed option. */
export class UsageError extends OrchError {
  constructor(message: string) {
    super(message, 2);
  }
}

/** Illegal transition or unmet prerequisite. */
export class WorkflowError extends OrchError {
  constructor(message: string) {
    super(message, 1);
  }
}

/** Invalid artifact, option value, or input. */
export class ValidationError extends OrchError {
  constructor(message: string) {
    super(message, 1);
  }
}

/** An external tool (git, gh) failed or refused; its stderr is in the message. */
export class ToolError extends OrchError {
  constructor(message: string) {
    super(message, 1);
  }
}

/** An SMTP send failed or was refused; the message never contains credentials. */
export class MailError extends OrchError {
  constructor(message: string) {
    super(message, 1);
  }
}

/** A merge stopped on conflicts and was aborted; `files` names the conflicting paths. */
export class MergeConflictError extends ToolError {
  readonly files: string[];

  constructor(ref: string, files: string[], detail: string) {
    super(
      `Merging ${ref} conflicts in: ${files.length ? files.join(', ') : '(unknown)'}. ` +
        `The merge was aborted. ${detail}`,
    );
    this.files = files;
  }
}

export class NotFoundError extends OrchError {
  constructor(message: string) {
    super(message, 3);
  }
}

/**
 * The factory controller found a lock generation higher than its own: another controller took
 * over (after this one looked stale, as when the machine slept). It stops without writing.
 */
export class LostLockError extends OrchError {
  constructor(pid: number | null) {
    super(
      'Another factory controller took the lock' +
        (pid === null ? '' : ` (PID ${String(pid)})`) +
        '; this controller stopped without writing anything more. See orch status; ' +
        'orch resume continues the session when no controller runs.',
      1,
    );
  }
}

/** Job owned by another session, bad token, or stale revision. */
export class OwnershipError extends OrchError {
  constructor(message: string) {
    super(message, 4);
  }
}
