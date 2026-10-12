import { useState } from 'react';
import { useBusiness } from '../business/BusinessContext';
import { EmptyState, ErrorState, Loading } from '../components/States';
import { useApi } from '../lib/ApiContext';
import { customerLabel, formatDateTime, type CustomerRow, type LeadStatus } from '../lib/types';
import { useResource } from '../lib/useResource';

const LEAD_STATUSES: LeadStatus[] = ['new', 'contacted', 'qualified', 'won', 'lost'];

export function CustomersPage() {
  const api = useApi();
  const { current } = useBusiness();
  const bid = encodeURIComponent(current.business_id);
  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [data, reload, setData] = useResource(
    (signal) =>
      api.request<{ customers: CustomerRow[] }>(
        `/api/customers?business_id=${bid}${submitted ? `&q=${encodeURIComponent(submitted)}` : ''}`,
        { signal },
      ),
    [api, bid, submitted],
  );

  async function updateLead(customer: CustomerRow, patch: { status?: LeadStatus; notes?: string }) {
    if (!customer.lead) return;
    setError(null);
    try {
      await api.request(`/api/customers?business_id=${bid}&lead_id=${encodeURIComponent(customer.lead.id)}`, {
        method: 'PATCH',
        body: patch,
      });
      if (data.status === 'ready') {
        setData({
          status: 'ready',
          data: {
            customers: data.data.customers.map((c) =>
              c.id === customer.id && c.lead ? { ...c, lead: { ...c.lead, ...patch } } : c,
            ),
          },
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update the lead.');
    }
  }

  return (
    <section aria-labelledby="customers-heading">
      <h1 id="customers-heading">Customers &amp; leads</h1>
      <form
        className="search"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(query.trim());
        }}
      >
        <input
          type="search"
          aria-label="Search customers"
          placeholder="Name or phone number"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          maxLength={100}
        />
        <button type="submit" className="btn">
          Search
        </button>
      </form>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {data.status === 'loading' && <Loading label="Loading customers…" />}
      {data.status === 'error' && <ErrorState message={data.error.message} onRetry={reload} />}
      {data.status === 'ready' && data.data.customers.length === 0 && (
        <EmptyState title={submitted ? 'No customers match your search' : 'No customers yet'}>
          {!submitted && <p>Everyone who messages your WhatsApp number is listed here as a lead.</p>}
        </EmptyState>
      )}
      {data.status === 'ready' && data.data.customers.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Customer</th>
                <th scope="col">Last message</th>
                <th scope="col">Orders</th>
                <th scope="col">Lead status</th>
                <th scope="col">Notes</th>
              </tr>
            </thead>
            <tbody>
              {data.data.customers.map((c) => (
                <tr key={c.id}>
                  <td data-label="Customer">{customerLabel(c)}</td>
                  <td data-label="Last message">{formatDateTime(c.last_message_at)}</td>
                  <td data-label="Orders">{c.orders_count}</td>
                  <td data-label="Lead status">
                    {c.lead ? (
                      <select
                        aria-label={`Lead status for ${customerLabel(c)}`}
                        value={c.lead.status}
                        onChange={(e) => void updateLead(c, { status: e.target.value as LeadStatus })}
                      >
                        {LEAD_STATUSES.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td data-label="Notes">
                    {c.lead && (
                      <input
                        aria-label={`Notes for ${customerLabel(c)}`}
                        defaultValue={c.lead.notes}
                        maxLength={4000}
                        onBlur={(e) => e.target.value !== c.lead!.notes && void updateLead(c, { notes: e.target.value })}
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
