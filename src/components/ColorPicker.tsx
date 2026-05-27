// =============================================================================
//  ColorPicker.tsx
//  Compact swatch picker. Eight luxe colors in a single row, click to pick.
// =============================================================================

import { LUXE_PALETTE } from '../lib/colors';

type ColorPickerProps = {
  value: string;
  onChange: (color: string) => void;
};

export function ColorPicker({ value, onChange }: ColorPickerProps) {
  return (
    <div className="grid grid-cols-8 gap-2">
      {LUXE_PALETTE.map((c) => {
        const selected = c === value;
        return (
          <button
            key={c}
            type="button"
            onClick={() => onChange(c)}
            aria-label={`Select color ${c}`}
            title={c}
            className={
              'h-9 w-full border transition-all ' +
              (selected
                ? 'border-neutral-50 ring-2 ring-neutral-50/40 ring-offset-2 ring-offset-neutral-950'
                : 'border-neutral-800 hover:border-neutral-500')
            }
            style={{ backgroundColor: c }}
          />
        );
      })}
    </div>
  );
}
