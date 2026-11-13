/** Errors carry the CLI exit code so handlers stay thin. 2 is reserved for usage errors. */
export class OrchError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode: number) {
    super(message);
    this.exitCode = exitCode;
    this.name = new.target.name;
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

export class NotFoundError extends OrchError {
  constructor(message: string) {
    super(message, 3);
  }
}

/** Job owned by another session, bad token, or stale revision. */
export class OwnershipError extends OrchError {
  constructor(message: string) {
    super(message, 4);
  }
}
