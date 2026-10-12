import { useState } from 'react';
import { useBusiness } from '../business/BusinessContext';
import { EmptyState, ErrorState, Loading } from '../components/States';
import { useApi } from '../lib/ApiContext';
import { formatMoney } from '../lib/money';
import { canManage, type Business, type Product } from '../lib/types';
import { useResource } from '../lib/useResource';
import { ProductForm, type ProductFormValues } from './ProductForm';

type Editing = { mode: 'none' } | { mode: 'new' } | { mode: 'edit'; product: Product };

export function ProductsPage() {
  const api = useApi();
  const { current } = useBusiness();
  const bid = encodeURIComponent(current.business_id);
  const [query, setQuery] = useState('');
  const [submittedQuery, setSubmittedQuery] = useState('');
  const [editing, setEditing] = useState<Editing>({ mode: 'none' });
  const [actionError, setActionError] = useState<string | null>(null);
  const manage = canManage(current.role);

  const [data, reload] = useResource(
    async (signal) => {
      const q = submittedQuery ? `&q=${encodeURIComponent(submittedQuery)}` : '';
      const [b, p] = await Promise.all([
        api.request<{ business: Business }>(`/api/business?business_id=${bid}`, { signal }),
        api.request<{ products: Product[] }>(`/api/products?business_id=${bid}${q}`, { signal }),
      ]);
      return { currency: b.business.currency, products: p.products };
    },
    [api, bid, submittedQuery],
  );

  async function save(values: ProductFormValues) {
    if (editing.mode === 'edit') {
      await api.request(`/api/products?business_id=${bid}&id=${encodeURIComponent(editing.product.id)}`, {
        method: 'PATCH',
        body: values,
      });
    } else {
      await api.request(`/api/products?business_id=${bid}`, { method: 'POST', body: values });
    }
    setEditing({ mode: 'none' });
    reload();
  }

  async function toggleAvailable(p: Product) {
    setActionError(null);
    try {
      await api.request(`/api/products?business_id=${bid}&id=${encodeURIComponent(p.id)}`, {
        method: 'PATCH',
        body: { is_available: !p.is_available },
      });
      reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not update the product.');
    }
  }

  async function remove(p: Product) {
    if (!window.confirm(`Delete "${p.name}"? Products that appear in orders are archived instead.`)) return;
    setActionError(null);
    try {
      await api.request(`/api/products?business_id=${bid}&id=${encodeURIComponent(p.id)}`, { method: 'DELETE' });
      reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not delete the product.');
    }
  }

  return (
    <section aria-labelledby="products-heading">
      <div className="toolbar">
        <h1 id="products-heading">Products &amp; services</h1>
        <span className="spacer" />
        {manage && editing.mode === 'none' && (
          <button type="button" className="btn btn--primary" onClick={() => setEditing({ mode: 'new' })}>
            Add product
          </button>
        )}
      </div>
      {!manage && <p className="muted">You have read-only access. Ask an owner or admin to make changes.</p>}

      <form
        className="search"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          setSubmittedQuery(query.trim());
        }}
      >
        <input
          type="search"
          placeholder="Search by name"
          aria-label="Search products"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          maxLength={100}
        />
        <button type="submit" className="btn">
          Search
        </button>
      </form>

      {actionError && (
        <p className="error" role="alert">
          {actionError}
        </p>
      )}

      {data.status === 'ready' && editing.mode !== 'none' && (
        <ProductForm
          currency={data.data.currency}
          initial={editing.mode === 'edit' ? editing.product : undefined}
          onSubmit={save}
          onCancel={() => setEditing({ mode: 'none' })}
        />
      )}

      {data.status === 'loading' && <Loading label="Loading products…" />}
      {data.status === 'error' && <ErrorState message={data.error.message} onRetry={reload} />}
      {data.status === 'ready' && data.data.products.length === 0 && (
        <EmptyState title={submittedQuery ? 'No products match your search' : 'No products yet'}>
          {!submittedQuery && <p>Add the products and services the AI agent may offer to customers.</p>}
        </EmptyState>
      )}
      {data.status === 'ready' && data.data.products.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Price</th>
                <th scope="col">Stock</th>
                <th scope="col">Status</th>
                {manage && <th scope="col">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {data.data.products.map((p) => (
                <tr key={p.id}>
                  <td data-label="Name">
                    <div>{p.name}</div>
                    <div className="muted small">
                      {p.kind}
                      {p.sku ? ` · ${p.sku}` : ''}
                      {p.category ? ` · ${p.category}` : ''}
                    </div>
                  </td>
                  <td data-label="Price">{formatMoney(p.price_minor, data.data.currency)}</td>
                  <td data-label="Stock">{p.stock_quantity ?? '—'}</td>
                  <td data-label="Status">
                    <span className={p.is_available ? 'badge badge--ok' : 'badge'}>
                      {p.is_available ? 'Available' : 'Unavailable'}
                    </span>
                  </td>
                  {manage && (
                    <td data-label="Actions" className="actions">
                      <button type="button" className="btn btn--small" onClick={() => setEditing({ mode: 'edit', product: p })}>
                        Edit
                      </button>
                      <button type="button" className="btn btn--small" onClick={() => void toggleAvailable(p)}>
                        {p.is_available ? 'Mark unavailable' : 'Mark available'}
                      </button>
                      <button type="button" className="btn btn--small btn--danger" onClick={() => void remove(p)}>
                        Delete
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
