# Megalodi-Wichteln

Vue 3 client and Node.js WebSocket server for a private Secret Santa draw with 3–20 participants.

## Local development

1. Install Node.js 22 or later.
2. Run `npm install` from the project directory.
3. Copy `.env.example` to `.env` and set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, and `MAIL_FROM` if you want to send emails. The server loads `.env` automatically during local development.
4. Run `npm run build`, then `npm start`.
5. Open `http://localhost:3000`.

For client hot reload, start the server in one terminal and run `npm --prefix client run dev` in another terminal, then open the Vite URL it prints.

## Synology NAS deployment

1. Copy the project to the NAS and create a `.env` file based on `.env.example`.
2. The container is published on NAS port `3017` and forwards to its internal HTTP port `3000`. Configure the Synology reverse proxy to route your HTTPS domain to the NAS on port `3017`, with WebSocket enabled. The browser will then use WSS automatically.
3. From the project directory, run `docker compose up -d --build`.
4. Open the HTTPS domain in a browser.

Assignment logs are written to `data/assignments.log` and persisted by the Compose volume. They contain the complete mapping, so restrict access to the NAS directory. Configure `SMTP_HOST` and `MAIL_FROM` in the `.env` file beside `docker-compose.yml` to email participants who entered an address. Compose passes this file into the container; after changing it, recreate the container with `docker compose up -d --build`. On startup, the server logs whether the required SMTP settings are present without exposing their values. If SMTP is not configured, the draw still completes and the server logs that configured email delivery was skipped.

The test-only readiness toggle is `Ctrl+Shift+G`. Normally, participants press and hold the readiness button; releasing it withdraws readiness. The server tolerates up to 15 seconds without a heartbeat and keeps a disconnected participant reserved for 30 seconds; the client reconnects automatically during that grace period. Reconnected participants must confirm readiness again. Each unique name may join only once per draw. Each draw accepts 3–20 participants. Five seconds after publishing the result, the participants are disconnected and the server clears the draw, remaining online for the next group. Participants in a later draw should reload the page and join again.
