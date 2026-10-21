import type { IncomingMessage, ServerResponse } from 'http'

export function handleApiRequest(
  req: IncomingMessage,
  res: ServerResponse
): Promise<boolean>
