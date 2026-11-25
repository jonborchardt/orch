/** Typed fetch wrappers. State changes carry the CSRF token from /api/session. */
import type {
  ActionRequest,
  ActionResponse,
  AgentRow,
  ApiError,
  Area,
  BoardRow,
  JobDetailView,
  RunnerStatus,
  RunsView,
  SessionInfo,
  SessionLogView,
  TicketDetail,
  TicketEvent,
  TicketList,
  TicketView,
  UsageRange,
  UsageView,
} from '../../src/server/types.ts';

export class ApiFailure extends Error {
  readonly status: number;
  readonly type: string;

  constructor(status: number, type: string, message: string) {
    super(message);
    this.status = status;
    this.type = type;
  }
}

async function parse<T>(res: Response): Promise<T> {
  if (res.ok) return (await res.json()) as T;
  let body: ApiError | undefined;
  try {
    body = (await res.json()) as ApiError;
  } catch {
    body = undefined;
  }
  throw new ApiFailure(
    res.status,
    body?.error.type ?? 'HttpError',
    body?.error.message ?? `${String(res.status)} ${res.statusText}`,
  );
}

async function getJson<T>(path: string): Promise<T> {
  return parse<T>(await fetch(path, { headers: { Accept: 'application/json' } }));
}

export const fetchBoard = (repo?: string) =>
  getJson<BoardRow[]>(`/api/jobs${repo ? `?repo=${encodeURIComponent(repo)}` : ''}`);
export const fetchRepos = () => getJson<string[]>('/api/repos');
export const fetchDetail = (id: string) => getJson<JobDetailView>(`/api/jobs/${id}`);
export const fetchRuns = () => getJson<RunsView>('/api/runs');
export const fetchAgents = () => getJson<AgentRow[]>('/api/agents');
export const fetchUsage = (hours: UsageRange) =>
  getJson<UsageView>(`/api/usage?hours=${String(hours)}`);
export const fetchSessionLog = (id: string) =>
  getJson<SessionLogView>(`/api/jobs/${id}/session-log`);

let session: Promise<SessionInfo> | undefined;
export function fetchSession(): Promise<SessionInfo> {
  session ??= getJson<SessionInfo>('/api/session').catch((err: unknown) => {
    session = undefined;
    throw err;
  });
  return session;
}

/** A state-changing request: JSON body, the CSRF token, and one retry with a fresh token. */
async function post<T>(path: string, body: unknown, retry = true): Promise<T> {
  const { csrf } = await fetchSession();
  const res = await fetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Orch-Csrf': csrf,
    },
    body: JSON.stringify(body),
  });
  try {
    return await parse<T>(res);
  } catch (err) {
    // The token is per `orch ui` process: a page left open across a restart holds a dead one.
    // The server refused before acting, so fetching the new token and resending once is safe.
    if (retry && err instanceof ApiFailure && err.message === 'Invalid CSRF token') {
      session = undefined;
      return post<T>(path, body, false);
    }
    throw err;
  }
}

export const postAction = (id: string, body: ActionRequest) =>
  post<ActionResponse>(`/api/jobs/${id}/actions`, body);

/** `order` is the server's proposed order of the open tickets; `all` is every ticket by id. */
export const fetchTickets = (view: 'all' | 'order') =>
  getJson<TicketList>(`/api/tickets?view=${view}`);
export const fetchTicket = (id: number) => getJson<TicketDetail>(`/api/tickets/${String(id)}`);
export const fetchTicketHistory = (id: number) =>
  getJson<TicketEvent[]>(`/api/tickets/${String(id)}/history`);
export const fetchAreas = () => getJson<Area[]>('/api/tickets/areas');
export const fetchRunner = () => getJson<RunnerStatus>('/api/runner');
/** `repo` is a path inside the repository; the server resolves and validates everything. */
export const createTicket = (body: Record<string, unknown>) =>
  post<TicketView>('/api/tickets', body);
/** One `orch ticket` mutation; `revision` makes the server refuse a ticket changed since. */
export const ticketAction = (
  id: number,
  body: { action: string; revision: number } & Record<string, unknown>,
) => post<TicketView>(`/api/tickets/${String(id)}/actions`, body);
