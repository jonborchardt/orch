/** Typed fetch wrappers. State changes carry the CSRF token from /api/session. */
import type {
  ActionRequest,
  ActionResponse,
  ApiError,
  BoardRow,
  JobDetailView,
  SessionInfo,
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

let session: Promise<SessionInfo> | undefined;
export function fetchSession(): Promise<SessionInfo> {
  session ??= getJson<SessionInfo>('/api/session').catch((err: unknown) => {
    session = undefined;
    throw err;
  });
  return session;
}

export async function postAction(
  id: string,
  body: ActionRequest,
  retry = true,
): Promise<ActionResponse> {
  const { csrf } = await fetchSession();
  const res = await fetch(`/api/jobs/${id}/actions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Orch-Csrf': csrf,
    },
    body: JSON.stringify(body),
  });
  try {
    return await parse<ActionResponse>(res);
  } catch (err) {
    // The token is per `orch ui` process: a page left open across a restart holds a dead one.
    // The server refused before acting, so fetching the new token and resending once is safe.
    if (retry && err instanceof ApiFailure && err.message === 'Invalid CSRF token') {
      session = undefined;
      return postAction(id, body, false);
    }
    throw err;
  }
}
