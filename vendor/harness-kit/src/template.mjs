/** {{VAR}} substitution with full JSON-string escaping, so Windows paths and quotes survive the round trip into hook configs. */

export function escapeForJsonString(value) {
  return JSON.stringify(String(value)).slice(1, -1);
}

export function renderTemplate(text, vars = {}) {
  let out = String(text);
  for (const [key, value] of Object.entries(vars)) {
    out = out.replaceAll(`{{${key}}}`, escapeForJsonString(value));
  }
  return out;
}

const PATH_PLACEHOLDER = /\{([^{}]+)\}/g;

export function renderPath(template, vars = {}) {
  if (typeof template !== 'string' || template === '') throw new Error('renderPath: template is required');
  return template.replace(PATH_PLACEHOLDER, (match, key) => {
    const value = vars[key];
    if (typeof value !== 'string' || value === '') throw new Error(`renderPath: no value for ${match} in ${JSON.stringify(template)}`);
    return value;
  });
}
