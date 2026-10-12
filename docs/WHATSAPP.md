# WhatsApp Cloud API

## How events flow

```
Meta ──POST──▶ /api/webhooks/whatsapp
                1. read raw bytes (max 1 MB)
                2. verify X-Hub-Signature-256 = HMAC-SHA256(raw bytes, WHATSAPP_APP_SECRET)
                   constant-time compare; failure → 401, nothing parsed or stored
                3. parse JSON + validate envelope (Zod); malformed → 400
                4. split into events: msg:<wamid>, status:<wamid>:<status>
                5. resolve tenant: metadata.phone_number_id → business_integrations
                   (unknown number → stored as "ignored", no data created)
                6. INSERT webhook_events ON CONFLICT DO NOTHING (dedupe)
                   database error → 500 so Meta retries
                7. respond 200
                8. after the response (waitUntil): claim → process → finish
                     message: customer, conversation, message, first lead, usage (one transaction)
                     status:  forward-only status update on our outbound message
```

- **Dedupe.** Meta retries deliveries and can send the same message twice.
  The event key is unique in `webhook_events`, and `messages` is unique on
  `(business_id, wa_message_id)`, so a retry creates nothing new and never
  triggers a second reply.
- **Retries.** A failed event backs off exponentially (2, 4, 8, 16 minutes)
  for up to 5 attempts, then stays `failed` for investigation. Events stuck
  in `processing` (crashed function) become claimable when their lock
  expires. `/api/jobs/process-events` drains the queue. It runs daily via
  Vercel Cron (the Hobby plan limit) and can be called manually:
  `curl -H "Authorization: Bearer $CRON_SECRET" https://<app>/api/jobs/process-events`.
- **Statuses** are handled separately from messages. Out-of-order updates
  only move forward (`sent → delivered → read`); `failed` is kept with
  Meta's error code. A status that arrives before our send finished is
  retried; one for a message we never sent is dropped after 3 attempts.
- **Outbound** (`server/whatsapp/sender.ts`): the database first reserves the
  message after checking the business is active, the conversation belongs
  to it, WhatsApp's 24-hour customer service window is open, and the
  monthly outbound limit is not reached. Only then is the Graph API called.
  A message is marked `sent` only with a WhatsApp message id returned by
  Meta.
- **Human handover / AI off.** Messages are always recorded. The AI
  responder (Phase 4) runs only when the conversation is `open`, the
  business has AI enabled and is active.
- **Logging.** Server logs carry ids and counts, not message text or phone
  numbers. Errors go to `audit_logs` with level `error`.

## Meta setup (test number)

1. Create a Meta developer account at developers.facebook.com and a
   **Business** type app. Add the **WhatsApp** product.
2. **WhatsApp → API Setup** gives a test phone number, its **Phone number
   ID** (`WHATSAPP_PHONE_NUMBER_ID`) and a temporary access token (expires in
   about 24 hours). Add your own phone as a test recipient.
3. **App settings → Basic → App secret** → `WHATSAPP_APP_SECRET`.
4. Generate `WHATSAPP_VERIFY_TOKEN` yourself: `openssl rand -hex 32`.
5. Set `WHATSAPP_API_VERSION` to the current version shown in API Setup's
   sample request (format `v23.0`).
6. Deploy (see the deployment docs), then in **WhatsApp → Configuration →
   Webhook**: Callback URL `https://<your-domain>/api/webhooks/whatsapp`,
   Verify token = `WHATSAPP_VERIFY_TOKEN`, click **Verify and save**, then
   **subscribe to the `messages` field**.
7. Map the number to a business:
   `npm run onboard -- --email … --business … --phone-number-id <id> --confirm`
   (or insert into `business_integrations` for an existing business).

Vercel preview deployments are protected by default and Meta cannot pass
that protection. Point the webhook at the production domain, or configure a
protection bypass for automation.

## Production token

The temporary token expires. For production create a **System User** in Meta
Business Settings, assign the app and WhatsApp account with
`whatsapp_business_messaging` and `whatsapp_business_management`, and
generate a non-expiring token. Store it only in Vercel as
`WHATSAPP_ACCESS_TOKEN` (Sensitive).

One operator token serves all client numbers that are in WhatsApp accounts
your Meta app manages. Each client's number is mapped in
`business_integrations`; `WHATSAPP_PHONE_NUMBER_ID` in env is only the
default number for the test scripts.

## Local testing

```bash
npm run dev:api
npm run webhook:test -- --phone-number-id <mapped id> --text "Do you have coffee?"
```

`webhook:test` signs a sample event with your local `WHATSAPP_APP_SECRET`
and posts it to the local runner (or a `*.vercel.app` URL). It does not send
anything to WhatsApp and costs nothing.

## Costs

Replies within the 24-hour customer service window are free under Meta's
current pricing; business-initiated template messages are charged per
message. This system only replies inside the window. Check Meta's pricing
page for your countries before going live.
