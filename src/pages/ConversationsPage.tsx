import { useState, type FormEvent } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { useBusiness } from '../business/BusinessContext';
import { EmptyState, ErrorState, Loading } from '../components/States';
import { useApi } from '../lib/ApiContext';
import { formatMoney } from '../lib/money';
import {
  customerLabel,
  formatDateTime,
  ORDER_STATUS_LABEL,
  type ConversationDetail,
  type ConversationStatus,
  type ConversationSummary,
} from '../lib/types';
import { useResource } from '../lib/useResource';

const FILTERS: { value: ConversationStatus | ''; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'handover', label: 'Need a person' },
  { value: 'open', label: 'AI handling' },
  { value: 'closed', label: 'Closed' },
];

const STATUS_LABEL: Record<ConversationStatus, string> = { open: 'AI handling', handover: 'Needs a person', closed: 'Closed' };

export function ConversationsPage() {
  const api = useApi();
  const { current } = useBusiness();
  const bid = encodeURIComponent(current.business_id);
  const [params, setParams] = useSearchParams();
  const status = (params.get('status') ?? '') as ConversationStatus | '';
  const [data, reload] = useResource(
    (signal) =>
      api.request<{ conversations: ConversationSummary[] }>(
        `/api/conversations?business_id=${bid}${status ? `&status=${status}` : ''}`,
        { signal },
      ),
    [api, bid, status],
  );

  return (
    <section aria-labelledby="conv-heading">
      <div className="toolbar">
        <h1 id="conv-heading">Conversations</h1>
        <span className="spacer" />
        <button type="button" className="btn" onClick={reload}>
          Refresh
        </button>
      </div>
      <div className="tabs" role="tablist" aria-label="Filter conversations">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            role="tab"
            aria-selected={status === f.value}
            className={status === f.value ? 'tab tab--active' : 'tab'}
            onClick={() => setParams(f.value ? { status: f.value } : {})}
          >
            {f.label}
          </button>
        ))}
      </div>
      {data.status === 'loading' && <Loading label="Loading conversations…" />}
      {data.status === 'error' && <ErrorState message={data.error.message} onRetry={reload} />}
      {data.status === 'ready' && data.data.conversations.length === 0 && (
        <EmptyState title="No conversations here">
          <p>Customer chats appear here when they message your WhatsApp number.</p>
        </EmptyState>
      )}
      {data.status === 'ready' && data.data.conversations.length > 0 && (
        <ul className="list">
          {data.data.conversations.map((c) => (
            <li key={c.id}>
              <Link to={`/conversations/${c.id}`} className="list__item">
                <div className="list__main">
                  <strong>{customerLabel(c.customer)}</strong>
                  <span className="muted small">
                    {c.last_message ? `${c.last_message.direction === 'inbound' ? '' : 'You: '}${c.last_message.body}` : 'No messages'}
                  </span>
                </div>
                <div className="list__meta">
                  <span className={`badge badge--${c.status}`}>{STATUS_LABEL[c.status]}</span>
                  <span className="muted small">{formatDateTime(c.last_message_at)}</span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const SENDER_LABEL = { customer: 'Customer', ai: 'AI', agent: 'Team', system: 'Automatic' } as const;

export function ConversationDetailPage() {
  const api = useApi();
  const { id = '' } = useParams();
  const { current } = useBusiness();
  const bid = encodeURIComponent(current.business_id);
  const path = `/api/conversations?business_id=${bid}&id=${encodeURIComponent(id)}`;
  const [data, reload] = useResource(
    (signal) => api.request<{ conversation: ConversationDetail }>(path, { signal }),
    [api, path],
  );
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function setStatus(status: ConversationStatus) {
    setError(null);
    setBusy(true);
    try {
      await api.request(path, { method: 'PATCH', body: { status } });
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update the conversation.');
    } finally {
      setBusy(false);
    }
  }

  async function send(e: FormEvent) {
    e.preventDefault();
    if (!reply.trim()) return setError('Type a message first.');
    setError(null);
    setBusy(true);
    try {
      await api.request(path, { method: 'POST', body: { body: reply } });
      setReply('');
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the message.');
    } finally {
      setBusy(false);
    }
  }

  if (data.status === 'loading') return <Loading label="Loading conversation…" />;
  if (data.status === 'error') return <ErrorState message={data.error.message} onRetry={reload} />;
  const c = data.data.conversation;

  return (
    <section aria-labelledby="chat-heading">
      <p>
        <Link to="/conversations">← All conversations</Link>
      </p>
      <div className="toolbar">
        <h1 id="chat-heading">{customerLabel(c.customer)}</h1>
        <span className={`badge badge--${c.status}`}>{STATUS_LABEL[c.status]}</span>
        <span className="spacer" />
        {c.status === 'open' && (
          <button type="button" className="btn" disabled={busy} onClick={() => void setStatus('handover')}>
            Take over (pause AI)
          </button>
        )}
        {c.status === 'handover' && (
          <button type="button" className="btn" disabled={busy} onClick={() => void setStatus('open')}>
            Resume AI
          </button>
        )}
        {c.status !== 'closed' && (
          <button type="button" className="btn" disabled={busy} onClick={() => void setStatus('closed')}>
            Close
          </button>
        )}
      </div>
      {c.status === 'handover' && c.handover_reason && <p className="notice">Handed over: {c.handover_reason}</p>}

      <ol className="chat" aria-label="Messages">
        {c.messages.map((m) => (
          <li key={m.id} className={m.direction === 'inbound' ? 'bubble bubble--in' : 'bubble bubble--out'}>
            <span className="bubble__meta">
              {SENDER_LABEL[m.sender]} · {formatDateTime(m.created_at)}
              {m.direction === 'outbound' && ` · ${m.status}`}
              {m.error_code && ` (${m.error_code})`}
            </span>
            <span className="bubble__body">{m.body}</span>
          </li>
        ))}
      </ol>

      {c.status !== 'closed' && (
        <form className="card form" onSubmit={send}>
          <label htmlFor="reply">Reply as your team</label>
          <textarea
            id="reply"
            rows={3}
            maxLength={4096}
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            disabled={!c.can_reply || busy}
          />
          {!c.can_reply && (
            <p className="muted small">WhatsApp only allows replies within 24 hours of the customer’s last message.</p>
          )}
          <p className="muted small">Sending a reply pauses the AI for this conversation.</p>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <div className="form__actions">
            <button type="submit" className="btn btn--primary" disabled={!c.can_reply || busy}>
              {busy ? 'Sending…' : 'Send'}
            </button>
          </div>
        </form>
      )}
      {c.status === 'closed' && error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {c.orders.length > 0 && (
        <div className="card">
          <h2>Orders from this chat</h2>
          <ul>
            {c.orders.map((o) => (
              <li key={o.id}>
                <Link to={`/orders?status=${o.status}`}>{ORDER_STATUS_LABEL[o.status]}</Link> —{' '}
                {formatMoney(o.total_minor, o.currency)} · {formatDateTime(o.created_at)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
