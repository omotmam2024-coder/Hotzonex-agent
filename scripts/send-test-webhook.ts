/**
 * Sends a signed sample WhatsApp webhook to a local or preview deployment,
 * using WHATSAPP_APP_SECRET from your environment (never printed).
 *
 *   npm run webhook:test -- --phone-number-id 123456789 --from 15550001111 --text "Hi"
 *     [--url http://localhost:3001/api/webhooks/whatsapp]
 */
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { signBody } from '../server/whatsapp/signature.js';
import { loadLocalEnv } from './load-env.js';

loadLocalEnv();
const { values } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://localhost:3001/api/webhooks/whatsapp' },
    'phone-number-id': { type: 'string' },
    from: { type: 'string', default: '15550001111' },
    text: { type: 'string', default: 'Hello, what do you sell?' },
  },
});

const secret = process.env.WHATSAPP_APP_SECRET;
const phoneNumberId = values['phone-number-id'] ?? process.env.WHATSAPP_PHONE_NUMBER_ID;
if (!secret || !phoneNumberId) {
  console.error('Set WHATSAPP_APP_SECRET and pass --phone-number-id (or set WHATSAPP_PHONE_NUMBER_ID).');
  process.exit(2);
}
if (new URL(values.url).protocol !== 'http:' && !values.url.includes('.vercel.app')) {
  console.error('Refusing to send test events to a non-local, non-preview URL.');
  process.exit(2);
}

const body = JSON.stringify({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'test',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '0', phone_number_id: phoneNumberId },
            contacts: [{ wa_id: values.from, profile: { name: 'Test Customer' } }],
            messages: [
              {
                from: values.from,
                id: `wamid.test-${randomUUID()}`,
                timestamp: String(Math.floor(Date.now() / 1000)),
                type: 'text',
                text: { body: values.text },
              },
            ],
          },
        },
      ],
    },
  ],
});

const res = await fetch(values.url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signBody(body, secret) },
  body,
});
console.log(res.status, await res.text());
