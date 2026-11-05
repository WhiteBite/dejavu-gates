/** {{VAR}} substitution with full JSON-string escaping, so Windows paths and quotes survive the round trip into hook configs. */

export function escapeForJsonString(value) {
  return JSON.stringify(String(value)).slice(1, -1);
}

export function renderTemplate(text, vars = {}) {
  return String(text).replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (match, key) => (key in vars ? escapeForJsonString(vars[key]) : match));
}

const PATH_PLACEHOLDER = /\{([^{}]+)\}/g;

export function renderPath(template, vars = {}) {
  if (typeof template !== 'string' || template === '') throw new Error('renderPath: template is required');
  return template.replace(PATH_PLACEHOLDER, (match, key) => {
    const value = vars[key];
    if (typeof value !== 'string' || value === '') throw new Error(`renderPath: no value for ${match} in ${JSON.stringify(template)}`);
    if (!/^[A-Za-z0-9._-]+$/.test(value) || value.includes('..')) {
      throw new Error(`renderPath: unsafe value for ${match}: ${JSON.stringify(value)}`);
    }
    return value;
  });
}
