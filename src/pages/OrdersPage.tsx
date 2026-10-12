import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useBusiness } from '../business/BusinessContext';
import { EmptyState, ErrorState, Loading } from '../components/States';
import { useApi } from '../lib/ApiContext';
import { formatMoney } from '../lib/money';
import { canManage, customerLabel, formatDateTime, ORDER_STATUS_LABEL, type OrderRow, type OrderStatus, type PaymentStatus } from '../lib/types';
import { useResource } from '../lib/useResource';

const FILTERS: { value: OrderStatus | ''; label: string }[] = [
  { value: 'pending_confirmation', label: 'To confirm' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'fulfilled', label: 'Fulfilled' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: '', label: 'All' },
];

export function OrdersPage() {
  const api = useApi();
  const { current } = useBusiness();
  const manage = canManage(current.role);
  const bid = encodeURIComponent(current.business_id);
  const [params, setParams] = useSearchParams();
  const status = (params.get('status') ?? 'pending_confirmation') as OrderStatus | '';
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [data, reload] = useResource(
    (signal) => api.request<{ orders: OrderRow[] }>(`/api/orders?business_id=${bid}${status ? `&status=${status}` : ''}`, { signal }),
    [api, bid, status],
  );

  async function change(order: OrderRow, body: { status: OrderStatus } | { payment_status: PaymentStatus }, confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return;
    setError(null);
    setBusyId(order.id);
    try {
      await api.request(`/api/orders?business_id=${bid}&id=${encodeURIComponent(order.id)}`, { method: 'PATCH', body });
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update the order.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section aria-labelledby="orders-heading">
      <div className="toolbar">
        <h1 id="orders-heading">Orders</h1>
        <span className="spacer" />
        <button type="button" className="btn" onClick={reload}>
          Refresh
        </button>
      </div>
      <p className="muted small">
        Orders from WhatsApp are requests. Confirm them after checking stock and delivery. Mark payment only after you have
        verified it.
      </p>
      <div className="tabs" role="tablist" aria-label="Filter orders">
        {FILTERS.map((f) => (
          <button
            key={f.value || 'all'}
            type="button"
            role="tab"
            aria-selected={status === f.value}
            className={status === f.value ? 'tab tab--active' : 'tab'}
            onClick={() => setParams({ status: f.value })}
          >
            {f.label}
          </button>
        ))}
      </div>
      {!manage && <p className="muted">You have read-only access to orders.</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {data.status === 'loading' && <Loading label="Loading orders…" />}
      {data.status === 'error' && <ErrorState message={data.error.message} onRetry={reload} />}
      {data.status === 'ready' && data.data.orders.length === 0 && <EmptyState title="No orders here" />}
      {data.status === 'ready' && data.data.orders.length > 0 && (
        <ul className="orders">
          {data.data.orders.map((o) => (
            <li key={o.id} className="card order">
              <div className="toolbar">
                <strong>{customerLabel(o.customer)}</strong>
                <span className={`badge badge--${o.status}`}>{ORDER_STATUS_LABEL[o.status]}</span>
                <span className="badge">{o.payment_status}</span>
                <span className="spacer" />
                <span className="muted small">{formatDateTime(o.created_at)}</span>
              </div>
              <ul className="order__items">
                {o.items.map((i, idx) => (
                  <li key={idx}>
                    {i.quantity} × {i.product_name} — {formatMoney(i.line_total_minor, o.currency)}
                  </li>
                ))}
              </ul>
              <p>
                <strong>Total: {formatMoney(o.total_minor, o.currency)}</strong>
              </p>
              {o.customer_note && <p className="muted">Note: {o.customer_note}</p>}
              {o.conversation_id && (
                <p className="small">
                  <Link to={`/conversations/${o.conversation_id}`}>Open conversation</Link>
                </p>
              )}
              {manage && (
                <div className="form__actions">
                  {o.status === 'pending_confirmation' && (
                    <>
                      <button type="button" className="btn btn--primary" disabled={busyId === o.id} onClick={() => void change(o, { status: 'confirmed' })}>
                        Confirm
                      </button>
                      <button
                        type="button"
                        className="btn btn--danger"
                        disabled={busyId === o.id}
                        onClick={() => void change(o, { status: 'cancelled' }, 'Cancel this order?')}
                      >
                        Cancel
                      </button>
                    </>
                  )}
                  {o.status === 'confirmed' && (
                    <>
                      <button type="button" className="btn" disabled={busyId === o.id} onClick={() => void change(o, { status: 'fulfilled' })}>
                        Mark fulfilled
                      </button>
                      <button
                        type="button"
                        className="btn btn--danger"
                        disabled={busyId === o.id}
                        onClick={() => void change(o, { status: 'cancelled' }, 'Cancel this confirmed order? Reserved stock is released.')}
                      >
                        Cancel
                      </button>
                    </>
                  )}
                  {(o.status === 'confirmed' || o.status === 'fulfilled') && o.payment_status === 'unpaid' && (
                    <button
                      type="button"
                      className="btn"
                      disabled={busyId === o.id}
                      onClick={() => void change(o, { payment_status: 'paid' }, 'Mark as paid? Only do this after you have verified the payment.')}
                    >
                      Mark paid
                    </button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
