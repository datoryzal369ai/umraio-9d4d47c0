import { createFileRoute } from "@tanstack/react-router";
export const Route = createFileRoute("/api/public/tmp/env-check")({
  server: {
    handlers: {
      GET: async () => Response.json({ fly_token_present: Boolean(process.env["FLY_API_TOKEN"]) }),
    },
  },
});
