'use client'
/**
 * Choose a line from the catalog (0039): fills the row's description, price and
 * (if empty) quantity, and records the item in item_catalog_N. The values are a
 * copy the user can still edit; the server checks the item is active and in the
 * company, and stores its code and unit in the line.
 */
import { useState } from 'react'

export type PickerItem = { id: string; code: string; name: string; price_cents: number; unit: string; tax_rate: number | null }

function setField(form: HTMLFormElement, name: string, value: string, onlyIfEmpty = false) {
  const el = form.elements.namedItem(name)
  if (el instanceof HTMLInputElement && (!onlyIfEmpty || !el.value || el.value === '0')) el.value = value
}

export function CatalogLinePicker({ index, items, label, none }: { index: number; items: PickerItem[]; label: string; none: string }) {
  const [selected, setSelected] = useState('')
  if (items.length === 0) return null
  return (
    <label className="field-label sm:col-span-6">
      {label}
      <select
        value={selected}
        className="field mt-2"
        data-testid={`catalog-pick-${index}`}
        onChange={(e) => {
          const id = e.target.value
          setSelected(id)
          const item = items.find((i) => i.id === id)
          const form = e.currentTarget.form
          if (!item || !form) return
          setField(form, `item_description_${index}`, item.name)
          setField(form, `item_price_${index}`, (item.price_cents / 100).toFixed(2))
          setField(form, `item_quantity_${index}`, '1', true)
          if (item.tax_rate !== null) setField(form, 'tax_rate', String(item.tax_rate), true)   // a suggestion: the document keeps one rate
        }}
      >
        <option value="">{none}</option>
        {items.map((i) => <option key={i.id} value={i.id}>{i.code} · {i.name} · {(i.price_cents / 100).toFixed(2)} / {i.unit}</option>)}
      </select>
      <input type="hidden" name={`item_catalog_${index}`} value={selected} />
    </label>
  )
}
