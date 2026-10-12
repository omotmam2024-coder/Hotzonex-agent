import { Link } from 'react-router';
import { useBusiness } from '../business/BusinessContext';
import { ErrorState, Loading } from '../components/States';
import { useApi } from '../lib/ApiContext';
import { formatDateTime, type Overview } from '../lib/types';
import { useResource } from '../lib/useResource';

export function OverviewPage() {
  const api = useApi();
  const { current } = useBusiness();
  const bid = encodeURIComponent(current.business_id);
  const [data, reload] = useResource(
    (signal) => api.request<{ overview: Overview }>(`/api/overview?business_id=${bid}`, { signal }),
    [api, bid],
  );

  if (data.status === 'loading') return <Loading label="Loading overview…" />;
  if (data.status === 'error') return <ErrorState message={data.error.message} onRetry={reload} />;
  const o = data.data.overview;

  return (
    <section aria-labelledby="overview-heading">
      <h1 id="overview-heading">Overview</h1>
      {!o.whatsapp_connected && (
        <p className="notice" role="status">
          No WhatsApp number is connected yet. Contact your service provider to finish setup.
        </p>
      )}
      {!o.ai_enabled && (
        <p className="notice" role="status">
          AI replies are turned off. Messages are recorded for your team. <Link to="/settings">Change in settings</Link>
        </p>
      )}
      <div className="stats">
        <Stat label="Need a person" value={o.conversations_handover} to="/conversations?status=handover" highlight={o.conversations_handover > 0} />
        <Stat label="Orders to confirm" value={o.orders_pending} to="/orders?status=pending_confirmation" highlight={o.orders_pending > 0} />
        <Stat label="Open conversations" value={o.conversations_open} to="/conversations?status=open" />
        <Stat label="New leads" value={o.leads_new} to="/customers" />
        <Stat label="Orders confirmed this month" value={o.orders_confirmed_this_month} />
        <Stat label="Customers" value={o.customers_total} to="/customers" />
      </div>

      <div className="card">
        <h2>Usage this month</h2>
        <Meter label="AI requests" used={o.ai_requests_this_month} limit={o.monthly_ai_request_limit} />
        <Meter label="Messages sent" used={o.messages_out_this_month} limit={o.monthly_outbound_message_limit} />
        <p className="muted small">
          Messages received: {o.messages_in_this_month} · AI tokens: {o.ai_tokens_this_month.toLocaleString()}
        </p>
      </div>

      {o.recent_errors.length > 0 && (
        <div className="card">
          <h2>Recent problems (7 days)</h2>
          <ul>
            {o.recent_errors.map((e, i) => (
              <li key={i}>
                {e.action} — {formatDateTime(e.created_at)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function Stat({ label, value, to, highlight }: { label: string; value: number; to?: string; highlight?: boolean }) {
  const body = (
    <>
      <span className="stat__value">{value}</span>
      <span className="stat__label">{label}</span>
    </>
  );
  return to ? (
    <Link to={to} className={highlight ? 'stat stat--highlight' : 'stat'}>
      {body}
    </Link>
  ) : (
    <div className="stat">{body}</div>
  );
}

function Meter({ label, used, limit }: { label: string; used: number; limit: number }) {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 100;
  return (
    <div className="meter">
      <div className="meter__row">
        <span>{label}</span>
        <span>
          {used} / {limit}
        </span>
      </div>
      <div className="meter__bar" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={limit} aria-valuenow={used}>
        <span className={pct >= 90 ? 'meter__fill meter__fill--warn' : 'meter__fill'} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
