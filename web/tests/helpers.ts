import type { APIRequestContext } from '@playwright/test';

// Plain-HTTP Space CRUD server started by the backend (see app.ts).
const HTTP_BASE = 'http://localhost:8000';

// Create a space via POST /space and return its generated uuid. Spaces are
// no longer created on-demand, so e2e tests must create one before
// navigating to /space/{uuid}.
export async function createSpace(
  request: APIRequestContext,
  data: { name: string; description: string } = {
    name: 'E2E Space',
    description: 'created by e2e test',
  },
): Promise<string> {
  const res = await request.post(`${HTTP_BASE}/space`, { data });
  if (!res.ok()) {
    throw new Error(`createSpace failed: ${res.status()} ${await res.text()}`);
  }
  const body = await res.json();
  return body.uuid as string;
}

export function spaceUrl(uuid: string): string {
  return `/space/${uuid}`;
}
