// Serves the read-only review API and the bundled React frontend.
import { Database } from "bun:sqlite";
import page from "./review/index.html";
import { handleReviewApi } from "./review-api.ts";

export function serveReview(dbPath: string, port: number) {
  // Separate read-only handle: the review server can never mutate the queue.
  const db = new Database(dbPath, { readonly: true });
  return Bun.serve({
    port,
    hostname: "127.0.0.1",
    routes: { "/": page },
    fetch: (req) => handleReviewApi(db, req) ?? new Response("not found", { status: 404 }),
  });
}
