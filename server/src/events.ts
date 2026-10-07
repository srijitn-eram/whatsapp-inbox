import type { Response } from "express";

/** Server-sent events hub so every open inbox updates live. */
const clients = new Set<Response>();

export function addClient(res: Response) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.write(": connected\n\n");
  clients.add(res);
  const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
  res.on("close", () => {
    clearInterval(ping);
    clients.delete(res);
  });
}

export function broadcast(event: string, data: unknown) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(frame);
}
