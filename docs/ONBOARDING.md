# Client onboarding checklist

Use one copy per client. Do not collect passwords or tokens from the client
over chat or email.

## Before you start

- [ ] Agreement in place: pricing, monthly AI/message limits, who answers
      handed-over chats, data handling (customer messages are stored in your
      Supabase project).
- [ ] Client has a phone number that is **not** already registered on the
      WhatsApp app (or is willing to migrate it), and a Meta Business
      account (or you create one on their behalf with their consent).

## WhatsApp number

- [ ] Add the client's number to your WhatsApp Business Account (Meta
      WhatsApp Manager → Phone numbers → Add), verify it by SMS/voice with
      the client present, set the display name (Meta reviews it).
- [ ] Note the new **Phone number ID** (not the phone number).
- [ ] Confirm your System User token has access to that WhatsApp account.
- [ ] Payment method set in WhatsApp Manager if business-initiated messages
      will ever be used (this system only replies within 24 hours).

## Business setup

- [ ] Dry run, then apply:
      `npm run onboard -- --email <owner email> --business "<name>" --currency <ISO> --timezone <IANA> --phone-number-id <id>`
      `... --confirm`
- [ ] Owner receives the invite email, sets a password, signs in.
- [ ] Set limits if different from defaults (see `docs/DEPLOYMENT.md` §9).
- [ ] Add extra staff: insert into `business_members` with role `admin` or
      `agent` after they have an account (invite via onboard script's user
      lookup or Supabase Auth → Invite).

## Content (with the owner, in the dashboard)

- [ ] **Settings → Description** and **Approved information for the AI**:
      opening hours, location, delivery areas and fees, payment methods,
      return policy. Only facts the owner is happy for the AI to state.
- [ ] **Settings → Handover message** in the owner's tone.
- [ ] **Products**: every product/service with exact price, availability,
      and stock if tracked. Descriptions answer common questions.
- [ ] Owner understands: orders arrive as **requests**; they must confirm,
      fulfil and mark paid themselves; "Needs a person" chats need a human
      reply within 24 hours.

## Test before go-live

- [ ] From a test phone: ask about products, prices, an unavailable item,
      place an order, ask for a person. Check every answer is correct.
- [ ] Owner confirms the test order and replies to the handed-over chat.
- [ ] Cancel the test order; close the test conversation.
- [ ] Overview shows WhatsApp connected and usage counting.

## Go live

- [ ] Client starts sharing the number.
- [ ] Check in after 1 day and 1 week: review a sample of conversations,
      blocked replies / handovers in Overview → Recent problems, and usage
      against limits. Adjust approved information and products.

## Offboarding

- [ ] Disable the integration: `update business_integrations set status = 'disabled' where business_id = '…';`
- [ ] Suspend: `update businesses set status = 'suspended' where id = '…';`
- [ ] Remove or migrate the number in WhatsApp Manager.
- [ ] Export the client's data if requested (take a dump first; deletion is
      permanent). Then delete per your agreement. Orders are protected from
      accidental deletion, so remove them first, in one transaction:
      `begin; delete from orders where business_id = '…'; delete from businesses where id = '…'; commit;`
      This removes all of that business's data and nothing else
      (tested in `tests/db/offboard.test.ts`).
