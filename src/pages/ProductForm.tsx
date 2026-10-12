import { useState, type FormEvent } from 'react';
import { Field } from '../components/Field';
import { ApiError } from '../lib/api';
import { minorToInput, parseMoneyInput } from '../lib/money';
import type { Product } from '../lib/types';

export interface ProductFormValues {
  name: string;
  description: string;
  sku: string | null;
  category: string | null;
  kind: 'product' | 'service';
  price_minor: number;
  is_available: boolean;
  stock_quantity: number | null;
}

interface Props {
  currency: string;
  initial?: Product;
  onSubmit: (values: ProductFormValues) => Promise<void>;
  onCancel: () => void;
}

type Errors = Partial<Record<keyof ProductFormValues | 'form', string>>;

export function ProductForm({ currency, initial, onSubmit, onCancel }: Props) {
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [sku, setSku] = useState(initial?.sku ?? '');
  const [category, setCategory] = useState(initial?.category ?? '');
  const [kind, setKind] = useState<'product' | 'service'>(initial?.kind ?? 'product');
  const [price, setPrice] = useState(initial ? minorToInput(initial.price_minor, currency) : '');
  const [available, setAvailable] = useState(initial?.is_available ?? true);
  const [stock, setStock] = useState(initial?.stock_quantity == null ? '' : String(initial.stock_quantity));
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const next: Errors = {};
    const priceMinor = parseMoneyInput(price, currency);
    if (!name.trim()) next.name = 'Name is required.';
    if (priceMinor === null) next.price_minor = `Enter a price like ${minorToInput(1250, currency)}.`;
    const stockValue = stock.trim() === '' ? null : Number(stock);
    if (stockValue !== null && (!Number.isInteger(stockValue) || stockValue < 0)) {
      next.stock_quantity = 'Stock must be a whole number, or empty if not tracked.';
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    setBusy(true);
    try {
      await onSubmit({
        name: name.trim(),
        description: description.trim(),
        sku: sku.trim() || null,
        category: category.trim() || null,
        kind,
        price_minor: priceMinor!,
        is_available: available,
        stock_quantity: stockValue,
      });
    } catch (err) {
      if (err instanceof ApiError && err.details) {
        const fieldErrors: Errors = {};
        for (const d of err.details) fieldErrors[(d.path || 'form') as keyof Errors] = d.message;
        setErrors(fieldErrors);
      } else if (err instanceof ApiError && err.code === 'sku_taken') {
        setErrors({ sku: err.message });
      } else {
        setErrors({ form: err instanceof Error ? err.message : 'Could not save.' });
      }
    } finally {
      setBusy(false);
    }
  }


  return (
    <form className="card form" onSubmit={submit} noValidate aria-label={initial ? 'Edit product' : 'New product'}>
      <h2>{initial ? `Edit ${initial.name}` : 'New product or service'}</h2>
      <div className="form__grid">
        <Field label="Name" error={errors.name}>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />
        </Field>
        <Field label={`Price (${currency})`} error={errors.price_minor}>
          <input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
        </Field>
        <Field label="Type">
          <select value={kind} onChange={(e) => setKind(e.target.value as 'product' | 'service')}>
            <option value="product">Product</option>
            <option value="service">Service</option>
          </select>
        </Field>
        <Field label="Stock" hint="Leave empty if not tracked." error={errors.stock_quantity}>
          <input inputMode="numeric" value={stock} onChange={(e) => setStock(e.target.value)} />
        </Field>
        <Field label="SKU (optional)" error={errors.sku}>
          <input value={sku} onChange={(e) => setSku(e.target.value)} maxLength={64} />
        </Field>
        <Field label="Category (optional)" error={errors.category}>
          <input value={category} onChange={(e) => setCategory(e.target.value)} maxLength={80} />
        </Field>
      </div>
      <Field label="Description" hint="The AI uses this to answer customer questions." error={errors.description}>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} rows={3} />
      </Field>
      <label className="checkbox">
        <input type="checkbox" checked={available} onChange={(e) => setAvailable(e.target.checked)} />
        Available for ordering
      </label>
      {errors.form && (
        <p className="error" role="alert">
          {errors.form}
        </p>
      )}
      <div className="form__actions">
        <button type="submit" className="btn btn--primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}
