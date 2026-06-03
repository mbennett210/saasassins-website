// Thin wrapper. Consumer supplies the input/select/textarea as children,
// or uses the `as` convenience prop for simple cases.

import Select from './Select';

export default function FormField({
  label,
  name,
  as = 'input',
  value,
  onChange,
  type = 'text',
  placeholder,
  options,
  required,
  error,
  help,
  rows = 3,
  children,
  ...rest
}) {
  const id = name ? `ff-${name}` : undefined;
  const inputProps = { id, name, value, onChange, placeholder, required, ...rest };

  let input = children;
  if (!input) {
    if (as === 'textarea') {
      input = <textarea className="input" rows={rows} {...inputProps} />;
    } else if (as === 'select') {
      // Use the themed Select component. Synthesize a fake event for the
      // onChange handler so existing callers reading `e.target.value` keep
      // working without changes.
      const normalizedOptions = (options || []).map((o) =>
        typeof o === 'string' ? { value: o, label: o } : o
      );
      input = (
        <Select
          id={id}
          ariaLabel={typeof label === 'string' ? label : undefined}
          value={value}
          onChange={(v) => onChange?.({ target: { value: v, name } })}
          disabled={rest.disabled}
          ghost={rest.ghost}
          placeholder={placeholder || 'Select…'}
          options={normalizedOptions}
        />
      );
    } else {
      input = <input className="input" type={type} {...inputProps} />;
    }
  }

  return (
    <div className={`form-group ${error ? 'has-error' : ''}`}>
      {label && (
        <label className="form-label" htmlFor={id}>
          {label}
          {required && <span className="form-required" aria-hidden> *</span>}
        </label>
      )}
      {input}
      {error && <div className="form-error">{error}</div>}
      {help && !error && <div className="form-help">{help}</div>}
    </div>
  );
}
