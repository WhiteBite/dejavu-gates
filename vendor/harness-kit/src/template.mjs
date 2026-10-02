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
