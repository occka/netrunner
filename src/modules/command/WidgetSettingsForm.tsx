import { RotateCcw } from "lucide-react";
import { WallpaperPicker } from "@/components/WallpaperPicker";
import { compactConfig, isVisible, resolveConfig, type RawConfig, type WidgetSchema, type WidgetSetting } from "./widgets/settings";

/**
 * Form generated from a widget's settings schema. Every change is applied at
 * once (live preview); `onChange` receives only values that differ from the
 * defaults, which is what gets stored.
 */
export function WidgetSettingsForm({
  schema,
  config,
  onChange,
}: {
  schema: WidgetSchema;
  config: RawConfig | undefined;
  onChange: (config: RawConfig) => void;
}) {
  const values = resolveConfig(schema, config) as RawConfig;
  const set = (key: string, value: unknown) => onChange(compactConfig(schema, { ...values, [key]: value }));
  const customised = Object.keys(compactConfig(schema, values)).length;

  const groups: { name: string; fields: WidgetSetting[] }[] = [];
  for (const field of schema) {
    if (!isVisible(field, values)) continue;
    const name = field.group ?? "Content";
    let g = groups.find((x) => x.name === name);
    if (!g) groups.push((g = { name, fields: [] }));
    g.fields.push(field);
  }

  return (
    <div className="wsettings">
      {groups.map((g) => (
        <fieldset key={g.name} className="wsettings__group">
          <legend className="label">{g.name}</legend>
          {g.fields.map((f) => (
            <Field key={f.key} field={f} value={values[f.key]} onChange={(v) => set(f.key, v)} />
          ))}
        </fieldset>
      ))}
      <button className="btn btn--sm btn--ghost" disabled={customised === 0} onClick={() => onChange({})}>
        <RotateCcw size={12} /> Reset to defaults{customised > 0 ? ` (${customised} changed)` : ""}
      </button>
    </div>
  );
}

function Field({ field, value, onChange }: { field: WidgetSetting; value: unknown; onChange: (v: unknown) => void }) {
  const id = `ws-${field.key}`;
  const hint = field.hint && <span className="wsettings__hint muted">{field.hint}</span>;
  switch (field.kind) {
    case "toggle":
      return (
        <div className="wsettings__field">
          <label className="check" htmlFor={id}>
            <input id={id} type="checkbox" checked={value as boolean} onChange={(e) => onChange(e.target.checked)} />
            {field.label}
          </label>
          {hint}
        </div>
      );
    case "select":
      return (
        <div className="wsettings__field">
          <label className="label" htmlFor={id}>
            {field.label}
          </label>
          <select id={id} className="input" value={value as string} onChange={(e) => onChange(e.target.value)}>
            {field.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {hint}
        </div>
      );
    case "range":
      return (
        <div className="wsettings__field">
          <label className="label wsettings__range-label" htmlFor={id}>
            {field.label}
            <span className="mono">
              {value as number}
              {field.unit ?? ""}
            </span>
          </label>
          <input
            id={id}
            type="range"
            min={field.min}
            max={field.max}
            step={field.step}
            value={value as number}
            onChange={(e) => onChange(Number(e.target.value))}
          />
          {hint}
        </div>
      );
    case "image":
      return (
        <div className="wsettings__field">
          <span className="label">{field.label}</span>
          <WallpaperPicker value={value as string} onChange={onChange} />
          {hint}
        </div>
      );
    case "text":
      return (
        <div className="wsettings__field">
          <label className="label" htmlFor={id}>
            {field.label}
          </label>
          <input
            id={id}
            className="input"
            value={value as string}
            placeholder={field.placeholder}
            maxLength={field.maxLength}
            onChange={(e) => onChange(e.target.value)}
          />
          {hint}
        </div>
      );
  }
}
