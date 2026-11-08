// The settings a plugin gets in ctx.settings.get, as Broadcast's RuntimeClient#public_settings makes
// them (checked by spec/plugin-api-1-vectors.json settings): each non-secret declared setting with a
// saved value that is not blank, typed as the manifest declares; else its manifest default; else
// nothing. Secrets and keys the manifest does not declare are never sent.
type Json = unknown;
type Definition = { type?: string; secret?: boolean; default?: Json };

function blank(value: Json): boolean {
  return value === undefined || value === null || String(value).trim() === "";
}

// Broadcast stores the form's text; a boolean arrives as true or false and an integer as a number
function typed(value: Json, type: string | undefined): Json {
  const text = String(value).trim();
  if (type === "boolean") return ["true", "1", "on", "yes"].includes(text.toLowerCase());
  if (type === "integer") return /^-?\d+$/.test(text) ? Number.parseInt(text, 10) : value;
  return value;
}

export function publicSettings(definitions: Record<string, Definition> | undefined, saved: Record<string, Json>): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const [key, definition] of Object.entries(definitions ?? {})) {
    if (!definition || definition.secret === true) continue;
    if (!blank(saved[key])) out[key] = typed(saved[key], definition.type);
    else if (definition.default !== undefined) out[key] = definition.default;
  }
  return out;
}

// The value the settings form starts with: the saved one, else the manifest default
export function formValue(definition: Definition | undefined, saved: Json): Json {
  return blank(saved) && definition?.default !== undefined ? definition.default : saved;
}
